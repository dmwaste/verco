import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'

/**
 * Fire-and-forget POST to the send-notification Edge Function. Mirrors the
 * helper in create-booking/index.ts. Failures are logged but never thrown
 * back to the webhook — the Stripe event has already been processed and
 * the booking status has already flipped.
 */
async function invokeSendNotification(payload: {
  type: 'booking_created'
  booking_id: string
}): Promise<void> {
  try {
    const url = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/send-notification`
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)')
      console.error(
        `[notifications] send-notification returned ${res.status} for ${payload.type} ${payload.booking_id}: ${body}`
      )
    }
  } catch (err) {
    console.error(
      `[notifications] Failed to invoke send-notification for ${payload.type} ${payload.booking_id}:`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

serve(async (req) => {
  // Webhook only accepts POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
    apiVersion: '2024-12-18.acacia',
  })

  // ── 1. Verify Stripe HMAC signature ────────────────────────────────────────

  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  const body = await req.text()
  let event: Stripe.Event

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
    )
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    return new Response('Invalid signature', { status: 400 })
  }

  // Service-role client — webhook writes require bypassing RLS
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        await handleCheckoutCompleted(supabase, event.data.object as Stripe.Checkout.Session)
        break
      }
      case 'charge.refunded': {
        await handleChargeRefunded(supabase, event.data.object as Stripe.Charge)
        break
      }
      default:
        // Acknowledge unhandled events without error
        console.log(`Unhandled event type: ${event.type}`)
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err)
    return new Response('Webhook handler error', { status: 500 })
  }
})

// ── checkout.session.completed ───────────────────────────────────────────────
// Updates booking_payment status to 'paid', stores payment_intent and charge_id,
// transitions booking from 'Pending Payment' → 'Confirmed' (auto-confirm, 2026-05-18).

async function handleCheckoutCompleted(
  supabase: ReturnType<typeof createClient>,
  session: Stripe.Checkout.Session,
) {
  const sessionId = session.id

  // Idempotency: check if already processed
  const { data: payment } = await supabase
    .from('booking_payment')
    .select('id, booking_id, status')
    .eq('stripe_session_id', sessionId)
    .single()

  if (!payment) {
    console.error(`No booking_payment found for session ${sessionId}`)
    return
  }

  if (payment.status === 'paid') {
    console.log(`Session ${sessionId} already processed — skipping`)
    return
  }

  // Extract payment_intent and charge from the session
  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id ?? null

  // Retrieve the charge from the payment intent (for charge ID + receipt URL)
  let chargeId: string | null = null
  let receiptUrl: string | null = null
  if (paymentIntentId) {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
      apiVersion: '2024-12-18.acacia',
    })
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge'],
    })
    const latestCharge = pi.latest_charge
    if (typeof latestCharge === 'string') {
      chargeId = latestCharge
    } else if (latestCharge) {
      chargeId = latestCharge.id
      receiptUrl = latestCharge.receipt_url ?? null
    }
  }

  // Update booking_payment
  const { error: paymentUpdateError } = await supabase
    .from('booking_payment')
    .update({
      status: 'paid',
      stripe_payment_intent: paymentIntentId,
      stripe_charge_id: chargeId,
      receipt_url: receiptUrl,
    })
    .eq('id', payment.id)

  if (paymentUpdateError) {
    throw new Error(`Failed to update booking_payment: ${paymentUpdateError.message}`)
  }

  // Transition booking: Pending Payment → Confirmed (auto-confirm, Option B
  // from 2026-05-18). The DB trigger enforce_booking_state_transition was
  // extended in 20260518005936_auto_confirm_allow_pp_to_confirmed to permit
  // this direct transition — skipping the intermediate Submitted state
  // avoids twin audit-log entries and a redundant trigger fire.
  const { error: bookingUpdateError } = await supabase
    .from('booking')
    .update({ status: 'Confirmed' })
    .eq('id', payment.booking_id)
    .eq('status', 'Pending Payment')  // Guard: only transition if still Pending Payment

  if (bookingUpdateError) {
    throw new Error(`Failed to update booking status: ${bookingUpdateError.message}`)
  }

  console.log(`Checkout completed: booking_payment ${payment.id}, booking ${payment.booking_id} → Confirmed`)

  // Fire booking_created notification on the paid path. Mirrors the
  // free-path call in create-booking/index.ts. Fire-and-forget — failure
  // never reverts the Confirmed transition.
  void invokeSendNotification({
    type: 'booking_created',
    booking_id: payment.booking_id,
  })
}

// ── charge.refunded ──────────────────────────────────────────────────────────
// Updates refund_request with the Stripe refund ID and marks as Approved.

async function handleChargeRefunded(
  supabase: ReturnType<typeof createClient>,
  charge: Stripe.Charge,
) {
  const chargeId = charge.id

  // Find the booking_payment for this charge
  const { data: payment } = await supabase
    .from('booking_payment')
    .select('id, booking_id')
    .eq('stripe_charge_id', chargeId)
    .single()

  if (!payment) {
    console.error(`No booking_payment found for charge ${chargeId}`)
    return
  }

  // Get the latest refund from the charge
  const latestRefund = charge.refunds?.data?.[0]
  const stripeRefundId = latestRefund?.id ?? null

  // Find pending refund_request for this booking
  const { data: refundRequest } = await supabase
    .from('refund_request')
    .select('id, status')
    .eq('booking_id', payment.booking_id)
    .eq('status', 'Pending')
    .maybeSingle()

  if (!refundRequest) {
    // Idempotency: might already be processed, or refund was initiated directly in Stripe
    console.log(`No pending refund_request for booking ${payment.booking_id} — may already be processed`)
    return
  }

  if (refundRequest.status !== 'Pending') {
    console.log(`Refund request ${refundRequest.id} already processed — skipping`)
    return
  }

  const { error: refundUpdateError } = await supabase
    .from('refund_request')
    .update({
      status: 'Approved',
      stripe_refund_id: stripeRefundId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', refundRequest.id)

  if (refundUpdateError) {
    throw new Error(`Failed to update refund_request: ${refundUpdateError.message}`)
  }

  console.log(`Charge refunded: refund_request ${refundRequest.id} → Approved`)
}
