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

    // ── 4a. Tenancy check ─────────────────────────────────────────────────────
    // The fetch above is service-role (bypasses RLS) and the role gate at §2 is
    // GLOBAL — without this, a client-admin of tenant A holding tenant B's
    // request UUID could trigger a real Stripe refund on tenant B's charge
    // (single shared D&M Stripe account). Re-read through the caller's
    // RLS-scoped client: the refund_request_staff_select policy enforces
    // accessible_client_ids() + sub-client narrowing. No row → same 404 as a
    // missing id, so a cross-tenant probe can't confirm the request exists.
    const { data: visibleRequest } = await supabase
      .from('refund_request')
      .select('id')
      .eq('id', refund_request_id)
      .maybeSingle()

    if (!visibleRequest) {
      return errorResponse('Refund request not found', 404)
    }

    if (refundRequest.status !== 'Pending') {
      return errorResponse(
        `Refund request status is "${refundRequest.status}" — can only process "Pending" requests`,
        400
      )
    }

    // ── 4b. Claim the request (concurrency guard) ─────────────────────────────
    // Two concurrent POSTs (double-click, two admins) would both read
    // status='Pending' above and both reach Stripe. Claim the row with a
    // conditional write so exactly one proceeds: reviewed_at doubles as the
    // claim marker (NULL until claimed). A caught Stripe failure releases the
    // claim below so the request stays retryable; an uncaught crash leaves it
    // claimed — deliberate fail-closed for money (staff reconcile via Stripe).
    const { data: claimed, error: claimError } = await supabaseService
      .from('refund_request')
      .update({ reviewed_by: user.id, reviewed_at: new Date().toISOString() })
      .eq('id', refundRequest.id)
      .eq('status', 'Pending')
      .is('reviewed_at', null)
      .select('id')

    if (claimError) {
      return errorResponse(`Failed to claim refund request: ${claimError.message}`, 500)
    }
    if (!claimed || claimed.length === 0) {
      return errorResponse(
        'Refund request is already being processed (if a prior attempt crashed, verify in Stripe before retrying)',
        409,
      )
    }

    // From the claim onward, EVERY early return / caught failure must release
    // it, or the request wedges behind 409s forever (e.g. approving a refund
    // for a booking whose payment was never captured would 404 with the claim
    // stuck). Only an uncaught crash mid-Stripe leaves it claimed — deliberate
    // fail-closed for money (staff reconcile via Stripe first).
    const releaseClaim = async () => {
      await supabaseService
        .from('refund_request')
        .update({ reviewed_by: null, reviewed_at: null })
        .eq('id', refundRequest.id)
        .eq('status', 'Pending')
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
      await releaseClaim()
      return errorResponse(`Failed to load booking payments: ${paymentError.message}`, 500)
    }
    const paidWithCharge = (payments ?? []).filter((p) => p.stripe_charge_id)
    if (paidWithCharge.length === 0) {
      await releaseClaim()
      return errorResponse('No paid booking_payment with a Stripe charge found for this booking', 404)
    }

    // ── 6. Allocate the refund across charges + issue one Stripe refund each ──

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
      apiVersion: '2024-12-18.acacia',
    })

    // Each charge's remaining refundable comes from Stripe (amount − amount_refunded),
    // so a retry after a partial refund never over-refunds a charge. The
    // per-(request, charge) idempotency keys below make a same-allocation retry
    // return the ORIGINAL refund instead of issuing a second one; a changed
    // allocation trips Stripe's idempotency_error (loud failure, never a
    // silent double-pay).
    const charges: RefundableCharge[] = []
    try {
      for (const p of paidWithCharge) {
        const ch = await stripe.charges.retrieve(p.stripe_charge_id!)
        charges.push({
          bookingPaymentId: p.id,
          stripeChargeId: p.stripe_charge_id!,
          remainingCents: Math.max(0, ch.amount - ch.amount_refunded),
        })
      }
    } catch (err) {
      await releaseClaim()
      throw err
    }

    // A zero/negative-amount request would allocate no lines and previously
    // fell through to be marked Approved with no Stripe refund — fail loud.
    if (refundRequest.amount_cents <= 0) {
      await releaseClaim()
      return errorResponse('Refund request amount must be positive', 400)
    }

    const lines = allocateRefund(refundRequest.amount_cents, charges)
    const shortfall = refundShortfallCents(refundRequest.amount_cents, lines)
    if (shortfall > 0) {
      // The booking's charges can't cover the request — never silently
      // under-refund. `collected` accounting should prevent this; surface it.
      await releaseClaim()
      return errorResponse(
        `Requested refund ${refundRequest.amount_cents}c exceeds refundable across charges by ${shortfall}c`,
        409,
      )
    }

    const refundIds: string[] = []
    try {
      for (const line of lines) {
        const refund = await stripe.refunds.create(
          {
            charge: line.stripeChargeId,
            amount: line.amountCents,
            metadata: {
              refund_request_id: refundRequest.id,
              booking_id: refundRequest.booking_id,
              booking_payment_id: line.bookingPaymentId,
            },
          },
          // Per-(request, charge) idempotency: a retry of the same allocation
          // returns the original refund; a DIFFERENT amount under the same key
          // errors loudly instead of double-paying. Keys expire after ~24h at
          // Stripe — the claim above is the backstop beyond that window.
          { idempotencyKey: `${refundRequest.id}:${line.bookingPaymentId}` },
        )
        refundIds.push(refund.id)
      }
    } catch (err) {
      // Partial failure: refunds already issued stay issued (idempotency keys
      // make the retry safe); release the claim so staff can retry.
      await releaseClaim()
      throw err
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
