import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { z } from 'https://esm.sh/zod@3.23.8'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'
import { jsonResponse, optionsResponse, errorResponse } from '../_shared/cors.ts'

const CreateCheckoutRequest = z.object({
  booking_id: z.string().uuid(),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
})

serve(async (req) => {
  if (req.method === 'OPTIONS') return optionsResponse()

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return errorResponse('Unauthorized', 401)
  }

  // Authenticated user client — validates booking ownership
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )

  // Service-role client for inserting booking_payment
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

    // ── 2. Parse input ───────────────────────────────────────────────────────

    const body = await req.json()
    const parsed = CreateCheckoutRequest.safeParse(body)
    if (!parsed.success) {
      return errorResponse(parsed.error.message, 400)
    }

    const { booking_id, success_url, cancel_url } = parsed.data

    // ── 3. Fetch booking — RLS ensures user can only see their own ───────────

    const { data: booking, error: bookingError } = await supabase
      .from('booking')
      .select(`
        id, ref, status, contact_id, client_id, contractor_id,
        booking_item (
          id, service_id, no_services, unit_price_cents, is_extra,
          service:service_id ( name )
        )
      `)
      .eq('id', booking_id)
      .single()

    if (bookingError || !booking) {
      return errorResponse('Booking not found', 404)
    }

    // ── 4. Validate caller can access this booking ───────────────────────────

    // Admin users (staff roles) can create checkout for any booking they can
    // see via RLS — the SELECT query above already scopes to their tenant.
    // Residents must own the booking via contact_id match.
    const { data: roleData } = await supabase.rpc('current_user_role')
    const adminRoles = ['contractor-admin', 'contractor-staff', 'client-admin', 'client-staff']
    const isAdmin = adminRoles.includes(roleData)

    if (!isAdmin) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('contact_id')
        .eq('id', user.id)
        .single()

      if (!profile?.contact_id || profile.contact_id !== booking.contact_id) {
        return errorResponse('Booking does not belong to this user', 403)
      }
    }

    // ── 5. Validate status ───────────────────────────────────────────────────

    if (booking.status !== 'Pending Payment') {
      return errorResponse(
        `Booking status is "${booking.status}" — checkout only allowed for "Pending Payment"`,
        400
      )
    }

    // ── 6. Check for existing unpaid checkout session ─────────────────────────

    const { data: existingPayment } = await supabaseService
      .from('booking_payment')
      .select('id, stripe_session_id, status')
      .eq('booking_id', booking_id)
      .eq('status', 'pending')
      .maybeSingle()

    if (existingPayment) {
      // Existing pending session — try to retrieve it from Stripe
      const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
        apiVersion: '2024-12-18.acacia',
      })

      try {
        const session = await stripe.checkout.sessions.retrieve(existingPayment.stripe_session_id)
        if (session.status === 'open' && session.url) {
          return jsonResponse({ checkout_url: session.url })
        }
      } catch {
        // Session expired or invalid — fall through to create new one
      }

      // Mark old session as expired
      await supabaseService
        .from('booking_payment')
        .update({ status: 'expired' })
        .eq('id', existingPayment.id)
    }

    // ── 7. Build Stripe Checkout Session line items ──────────────────────────

    type BookingItemWithService = {
      id: string
      service_id: string
      no_services: number
      unit_price_cents: number
      is_extra: boolean
      service: { name: string }
    }

    const items = booking.booking_item as unknown as BookingItemWithService[]
    const paidItems = items.filter((i) => i.is_extra && i.unit_price_cents > 0)

    if (paidItems.length === 0) {
      return errorResponse('No paid items found — this booking should be free', 400)
    }

    const lineItems = paidItems.map((item) => ({
      price_data: {
        currency: 'aud',
        unit_amount: item.unit_price_cents,
        product_data: {
          name: `${item.service.name} (Extra Collection)`,
          metadata: {
            booking_item_id: item.id,
            service_id: item.service_id,
          },
        },
      },
      quantity: item.no_services,
    }))

    const totalCents = paidItems.reduce(
      (sum, i) => sum + i.unit_price_cents * i.no_services, 0
    )

    // ── 8. Create Stripe Checkout Session ────────────────────────────────────

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
      apiVersion: '2024-12-18.acacia',
    })

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    // Derive the app URL from the Supabase URL (Edge Functions don't have access to the frontend URL)
    // success/cancel URLs are set by the frontend via metadata — use booking ref as fallback
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      metadata: {
        booking_id: booking.id,
        booking_ref: booking.ref,
        client_id: booking.client_id,
        contractor_id: booking.contractor_id,
      },
      success_url,
      cancel_url,
      expires_at: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now
    })

    // ── 9. Insert booking_payment record ─────────────────────────────────────

    const { error: paymentError } = await supabaseService
      .from('booking_payment')
      .insert({
        booking_id: booking.id,
        client_id: booking.client_id,
        contractor_id: booking.contractor_id,
        stripe_session_id: session.id,
        amount_cents: totalCents,
        currency: 'aud',
        status: 'pending',
      })

    if (paymentError) {
      console.error('booking_payment insert error:', paymentError)
      return errorResponse('Failed to record payment session', 500)
    }

    // ── 10. Return checkout URL ──────────────────────────────────────────────

    return jsonResponse({ checkout_url: session.url })
  } catch (err) {
    console.error('create-checkout error:', err instanceof Error ? err.message : String(err))
    console.error('create-checkout stack:', err instanceof Error ? err.stack : 'no stack')
    const message = err instanceof Error ? err.message : String(err)
    return errorResponse(`Internal Server Error: ${message}`, 500)
  }
})
