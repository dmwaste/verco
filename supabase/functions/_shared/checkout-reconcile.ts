// EF-only shared module (NOT mirrored — consumers are all Deno EFs).
//
// Single source of truth for "this Stripe Checkout session is paid — make the
// booking reflect it": booking_payment → paid, booking Pending Payment →
// Confirmed (guarded), booking_created notification. Extracted from
// stripe-webhook (VER-252) so the webhook, the expiry/reminder cron, and
// create-checkout's session-reuse path all reconcile identically — payment
// paths must never drift.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'
import type { Database } from './database.types.ts'

// Typed against Verco's Database so the reconciliation writes (booking_payment,
// booking) are checked against the real schema — this is the money path. Derived
// from createClient<Database> (not SupabaseClient<Database> directly) so it is
// definitionally identical to what every caller passes in.
type SupabaseServiceClient = ReturnType<typeof createClient<Database>>

/**
 * Fire-and-forget POST to the send-notification Edge Function. Failures are
 * logged but never thrown — by the time we notify, the booking status has
 * already flipped and must not be reverted.
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

/**
 * Reconciles a paid (or webhook-delivered) Checkout session onto the booking.
 *
 * Every step is idempotent, so this is safe to call from webhook replays, the
 * hourly cron, and create-checkout's reuse path:
 *  - booking_payment update is skipped when the row is already 'paid'
 *    (but the booking transition still runs — fixes paid-row/stuck-booking)
 *  - the booking update is guarded on status = 'Pending Payment'
 *  - booking_created fires ONLY when this call performed the transition
 *    (a no-op guarded update must not email a cancelled/confirmed booking),
 *    and the dispatcher's idempotency keys dedupe any race
 */
export async function reconcileCheckoutSession(
  supabase: SupabaseServiceClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const sessionId = session.id

  const { data: payment } = await supabase
    .from('booking_payment')
    .select('id, booking_id, status')
    .eq('stripe_session_id', sessionId)
    .single()

  if (!payment) {
    console.error(`No booking_payment found for session ${sessionId}`)
    return
  }

  if (payment.status !== 'paid') {
    // Extract payment_intent and charge from the session
    const paymentIntentId = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id ?? null

    // Retrieve the charge from the payment intent (for charge ID + receipt URL)
    let chargeId: string | null = null
    let receiptUrl: string | null = null
    if (paymentIntentId) {
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
  }

  // Transition booking: Pending Payment → Confirmed (auto-confirm, Option B
  // from 2026-05-18; DB trigger permits the direct transition). The status
  // guard makes this idempotent and ensures we never resurrect a booking
  // that was cancelled while we deliberated.
  const { data: transitioned, error: bookingUpdateError } = await supabase
    .from('booking')
    .update({ status: 'Confirmed' })
    .eq('id', payment.booking_id)
    .eq('status', 'Pending Payment')
    .select('id')

  if (bookingUpdateError) {
    throw new Error(`Failed to update booking status: ${bookingUpdateError.message}`)
  }

  const didTransition = (transitioned ?? []).length > 0
  console.log(
    `Checkout reconciled: booking_payment ${payment.id}, booking ${payment.booking_id}` +
    (didTransition ? ' → Confirmed' : ' (no transition — booking not Pending Payment)')
  )

  // Fire booking_created on the paid path — only when THIS call confirmed the
  // booking. Mirrors the free-path call in create-booking/index.ts.
  if (didTransition) {
    void invokeSendNotification({
      type: 'booking_created',
      booking_id: payment.booking_id,
    })
  }
}
