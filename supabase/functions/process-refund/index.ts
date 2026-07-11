import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { z } from 'https://esm.sh/zod@3.23.8'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'
import { jsonResponse, optionsResponse, errorResponse } from '../_shared/cors.ts'
import { allocateRefund, refundShortfallCents, type RefundableCharge } from '../_shared/refund-allocation.ts'

const ProcessRefundRequest = z.object({
  refund_request_id: z.string().uuid(),
})

serve(async (req) => {
  if (req.method === 'OPTIONS') return optionsResponse()

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return errorResponse('Unauthorized', 401)
  }

  // User-scoped client for role validation
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )

  // Service-role client for writes
  const supabaseService = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    // ── 1. Validate auth — must be a logged-in user ──────────────────────────

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return errorResponse('Authentication required', 401)
    }

    // ── 2. Validate role — contractor-admin or client-admin only ─────────────

    const { data: userRole } = await supabaseService
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single()

    if (!userRole || !['contractor-admin', 'client-admin'].includes(userRole.role)) {
      return errorResponse('Insufficient permissions — requires contractor-admin or client-admin role', 403)
    }

    // ── 3. Parse input ───────────────────────────────────────────────────────

    const body = await req.json()
    const parsed = ProcessRefundRequest.safeParse(body)
    if (!parsed.success) {
      return errorResponse(parsed.error.message, 400)
    }

    const { refund_request_id } = parsed.data

    // ── 4. Fetch refund request ──────────────────────────────────────────────

    const { data: refundRequest, error: refundError } = await supabaseService
      .from('refund_request')
      .select('id, booking_id, amount_cents, status')
      .eq('id', refund_request_id)
      .single()

    if (refundError || !refundRequest) {
      return errorResponse('Refund request not found', 404)
    }

    if (refundRequest.status !== 'Pending') {
      return errorResponse(
        `Refund request status is "${refundRequest.status}" — can only process "Pending" requests`,
        400
      )
    }

    // ── 5. Fetch ALL paid booking_payment rows ───────────────────────────────
    // A booking can carry >1 paid charge once PR-B1's increase-delta charge
    // lands (original + delta). Refunds must spread across them — the old
    // `.single()` threw the moment a 2nd paid row existed (PR-B0 / review #4).
    // Newest charge first so the delta charge is refunded before the original.

    const { data: payments, error: paymentError } = await supabaseService
      .from('booking_payment')
      .select('id, stripe_charge_id, status, created_at')
      .eq('booking_id', refundRequest.booking_id)
      .eq('status', 'paid')
      .order('created_at', { ascending: false })

    if (paymentError) {
      return errorResponse(`Failed to load booking payments: ${paymentError.message}`, 500)
    }
    const paidWithCharge = (payments ?? []).filter((p) => p.stripe_charge_id)
    if (paidWithCharge.length === 0) {
      return errorResponse('No paid booking_payment with a Stripe charge found for this booking', 404)
    }

    // ── 6. Allocate the refund across charges + issue one Stripe refund each ──

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
      apiVersion: '2024-12-18.acacia',
    })

    // Each charge's remaining refundable comes from Stripe (amount − amount_refunded),
    // so a retry after a partial refund never over-refunds a charge.
    const charges: RefundableCharge[] = []
    for (const p of paidWithCharge) {
      const ch = await stripe.charges.retrieve(p.stripe_charge_id!)
      charges.push({
        bookingPaymentId: p.id,
        stripeChargeId: p.stripe_charge_id!,
        remainingCents: Math.max(0, ch.amount - ch.amount_refunded),
      })
    }

    const lines = allocateRefund(refundRequest.amount_cents, charges)
    const shortfall = refundShortfallCents(refundRequest.amount_cents, lines)
    if (shortfall > 0) {
      // The booking's charges can't cover the request — never silently
      // under-refund. `collected` accounting should prevent this; surface it.
      return errorResponse(
        `Requested refund ${refundRequest.amount_cents}c exceeds refundable across charges by ${shortfall}c`,
        409,
      )
    }

    const refundIds: string[] = []
    for (const line of lines) {
      const refund = await stripe.refunds.create({
        charge: line.stripeChargeId,
        amount: line.amountCents,
        metadata: {
          refund_request_id: refundRequest.id,
          booking_id: refundRequest.booking_id,
          booking_payment_id: line.bookingPaymentId,
        },
      })
      refundIds.push(refund.id)
    }
    const primaryRefundId = refundIds[0]

    // ── 7. Update refund_request ─────────────────────────────────────────────

    const { error: updateError } = await supabaseService
      .from('refund_request')
      .update({
        status: 'Approved',
        // Primary (newest-charge) refund id. When a request spans >1 charge the
        // full set is in refund metadata + Stripe; this column keeps the lead id.
        stripe_refund_id: primaryRefundId,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', refundRequest.id)

    if (updateError) {
      console.error('refund_request update error:', updateError)
      return errorResponse('Refund initiated but failed to update request record', 500)
    }

    // ── 8. Return result ─────────────────────────────────────────────────────

    return jsonResponse({ stripe_refund_id: primaryRefundId, stripe_refund_ids: refundIds })
  } catch (err) {
    console.error('process-refund error:', err)

    // Surface Stripe-specific errors
    if (err instanceof Stripe.errors.StripeError) {
      return errorResponse(`Stripe error: ${err.message}`, 502)
    }

    return errorResponse('Internal Server Error', 500)
  }
})
