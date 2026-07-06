import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'
import { reconcileCheckoutSession } from '../_shared/checkout-reconcile.ts'
import { withSentry } from '../_shared/sentry.ts'

serve(withSentry('stripe-webhook', async (req) => {
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
        await reconcileCheckoutSession(supabase, stripe, event.data.object as Stripe.Checkout.Session)
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
}))

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
