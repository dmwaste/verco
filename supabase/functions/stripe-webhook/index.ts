import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'
import { reconcileCheckoutSession } from '../_shared/checkout-reconcile.ts'
import { resolveLatestRefund, shouldAutoApproveRefund } from '../_shared/refund-auto-approve.ts'
import { captureWarning, withSentry } from '../_shared/sentry.ts'

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
  const supabase = createClient<Database>(
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
        await handleChargeRefunded(supabase, stripe, event.data.object as Stripe.Charge)
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
  supabase: ReturnType<typeof createClient<Database>>,
  stripe: Stripe,
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

  // Get the latest refund from the charge.
  //
  // The webhook PAYLOAD shape follows the WEBHOOK ENDPOINT's pinned Stripe API
  // version — NOT the SDK's `apiVersion` set above. On API versions >= 2022-11-15
  // the embedded `charge.refunds` list is OMITTED from the payload, so
  // `charge.refunds.data[0]` is undefined → every direct-in-Stripe refund would
  // read a null amount → never auto-approve → silently park Pending. Resolve via
  // the embed when present, else fetch (`resolveLatestRefund`), so the backstop
  // is correct regardless of the endpoint's pin — this also feeds the stamped-id
  // recovery path below.
  //
  // TODO(dan): confirm + document the LIVE endpoint's pinned API version in the
  // Stripe dashboard (D&M acct_1HKxMa → Developers → Webhooks → this endpoint →
  // "API version"). The fetch fallback makes correctness independent of the
  // answer, but recording the pin here removes the ambiguity for the next reader.
  const latestRefund = await resolveLatestRefund(
    charge.refunds?.data?.[0],
    async () => (await stripe.refunds.list({ charge: chargeId, limit: 1 })).data[0] ?? null,
  )
  const stripeRefundId = latestRefund?.id ?? null

  // #387.1 hardening: refunds created by process-refund carry the request id in
  // metadata — settle exactly that request instead of falling through to
  // oldest-Pending matching (which could settle a DIFFERENT request against
  // this refund when two Pending requests coexist). The status='Pending'
  // condition makes it a no-op when process-refund already approved it
  // synchronously; the only time this branch does work is the crash window
  // between process-refund's Stripe call and its status commit.
  const stampedRequestId = latestRefund?.metadata?.refund_request_id
  if (stampedRequestId) {
    const { data: settled, error: stampedError } = await supabase
      .from('refund_request')
      .update({
        status: 'Approved',
        stripe_refund_id: stripeRefundId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', stampedRequestId)
      .eq('status', 'Pending')
      .select('id')
    if (stampedError) {
      throw new Error(`Failed to update stamped refund_request ${stampedRequestId}: ${stampedError.message}`)
    }
    console.log(
      settled && settled.length > 0
        ? `Charge refunded: settled stamped refund_request ${stampedRequestId} (recovery path)`
        : `Charge refunded: stamped refund_request ${stampedRequestId} already settled — skipping`,
    )
    return
  }

  // Find a pending refund_request for this booking. A booking can carry >1
  // pending request once PR-B1's delta charge exists (full cancel of a
  // 2-charge booking), so `.maybeSingle()` would throw — take the oldest
  // pending one. This handler is only a BACKSTOP: process-refund (the primary
  // path) sets the request Approved synchronously before this fires, so it runs
  // only for refunds initiated directly in Stripe. Precise charge→request
  // mapping across concurrent pending requests is a PR-B1 concern (needs a
  // charge link on refund_request).
  const { data: pendingRequests } = await supabase
    .from('refund_request')
    .select('id, status, amount_cents')
    .eq('booking_id', payment.booking_id)
    .eq('status', 'Pending')
    .order('created_at', { ascending: true })
  const refundRequest = (pendingRequests ?? [])[0]

  if (!refundRequest) {
    // Idempotency: might already be processed, or refund was initiated directly in Stripe
    console.log(`No pending refund_request for booking ${payment.booking_id} — may already be processed`)
    return
  }

  if (refundRequest.status !== 'Pending') {
    console.log(`Refund request ${refundRequest.id} already processed — skipping`)
    return
  }

  // Amount guard (#387.2): this backstop only fires for refunds initiated
  // directly in Stripe (process-refund sets the request Approved synchronously).
  // A booking can carry >1 Pending request of DIFFERENT amounts (e.g. a queued
  // quantity-reduction refund + a full cancel). Approving the oldest one blindly
  // would settle the wrong request against this refund. Only auto-approve when
  // the refund amount matches the request; otherwise leave it Pending for a
  // human to reconcile, and log loudly.
  const latestRefundCents = latestRefund?.amount ?? null
  if (!shouldAutoApproveRefund(latestRefundCents, refundRequest.amount_cents)) {
    // Two ways to land here, both needing a human: (1) the refund amount could
    // not be resolved at all (embed absent AND the fetch found none), or (2) it
    // was resolved but does not match the oldest Pending request.
    const reason = latestRefundCents == null
      ? 'no refund amount could be resolved (embed absent + Stripe fetch found none)'
      : 'refund amount does not match the oldest Pending request'
    console.log(
      `Charge refund ${stripeRefundId ?? '(none)'} for booking ${payment.booking_id}: ${reason} — ` +
        `refund ${latestRefundCents}c vs oldest Pending request ${refundRequest.id} ` +
        `(${refundRequest.amount_cents}c) — leaving Pending for manual review`,
    )
    // Promote to a Sentry WARNING: a console.log alone is unwatched, and this is
    // the only signal that a direct-in-Stripe refund needs manual reconciliation.
    // IDs + amounts only — no PII (scrubEvent is a backstop, not a licence).
    captureWarning(`stripe-webhook: charge.refunded parked for manual review — ${reason}`, {
      booking_id: payment.booking_id,
      refund_request_id: refundRequest.id,
      stripe_refund_id: stripeRefundId,
      stripe_charge_id: chargeId,
      refund_amount_cents: latestRefundCents,
      request_amount_cents: refundRequest.amount_cents,
      refunds_embed_absent: (charge.refunds?.data?.[0] ?? null) == null,
    })
    return
  }

  // Conditional on the row still being Pending — a concurrent process-refund
  // approval between our read and this write must not be overwritten (TOCTOU:
  // clobbering reviewed_at/stripe_refund_id on a just-approved row).
  const { data: approved, error: refundUpdateError } = await supabase
    .from('refund_request')
    .update({
      status: 'Approved',
      stripe_refund_id: stripeRefundId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', refundRequest.id)
    .eq('status', 'Pending')
    .select('id')

  if (refundUpdateError) {
    throw new Error(`Failed to update refund_request: ${refundUpdateError.message}`)
  }

  console.log(
    approved && approved.length > 0
      ? `Charge refunded: refund_request ${refundRequest.id} → Approved`
      : `Charge refunded: refund_request ${refundRequest.id} settled concurrently — skipping`,
  )
}
