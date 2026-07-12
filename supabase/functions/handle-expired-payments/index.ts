import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'
import { reconcileCheckoutSession } from '../_shared/checkout-reconcile.ts'
import {
  decideExpiryAction,
  type ExpiryAction,
  type SessionPaidStatus,
} from '../_shared/expiry-decision.ts'

/**
 * handle-expired-payments cron Edge Function
 *
 * Runs hourly via pg_cron. Service role only — no user context.
 *
 * Both loops are paid-guarded (VER-252): before dunning or cancelling a
 * Pending Payment booking, EVERY booking_payment session is checked against
 * Stripe. A paid session anywhere → reconcile (the missed-webhook path: the
 * same confirm sequence the webhook runs). An unverifiable session → skip
 * this cycle, never act on a booking we couldn't verify.
 *
 *   1. 6h reminder — fresh send for Pending Payment bookings > 6h old
 *      without a prior sent/queued reminder; paid → reconcile instead of dun
 *   2. 24h expiry — paid → reconcile; verified-unpaid → safe-ordered cancel:
 *      insert queued log row, cancel booking, then dispatch by log_id
 *      (crash-safe). The paid-check runs BEFORE the log insert so a
 *      reconciled booking never carries a resumable "payment expired" email.
 */

interface Assessment {
  decision: ExpiryAction
  /** Sessions retrieved during assessment, so reconcile needn't re-fetch. */
  sessions: Map<string, Stripe.Checkout.Session>
}

async function assessBooking(
  supabase: ReturnType<typeof createClient<Database>>,
  stripe: Stripe,
  bookingId: string,
): Promise<Assessment> {
  const sessions = new Map<string, Stripe.Checkout.Session>()

  const { data: payments, error } = await supabase
    .from('booking_payment')
    .select('stripe_session_id, status')
    .eq('booking_id', bookingId)

  if (error) {
    // Can't see the payment rows — treat as unverifiable.
    console.error(`Payment lookup failed for ${bookingId}: ${error.message}`)
    return { decision: { action: 'skip' }, sessions }
  }

  const rows = (payments ?? []) as Array<{ stripe_session_id: string | null; status: string }>
  const statuses = new Map<string, SessionPaidStatus>()

  for (const row of rows) {
    const sid = row.stripe_session_id
    if (!sid || statuses.has(sid)) continue
    try {
      const session = await stripe.checkout.sessions.retrieve(sid)
      sessions.set(sid, session)
      statuses.set(sid, session.payment_status === 'paid' ? 'paid' : 'unpaid')
    } catch (err) {
      console.error(
        `Stripe session retrieve failed for ${sid} (booking ${bookingId}):`,
        err instanceof Error ? err.message : String(err),
      )
      statuses.set(sid, 'error')
    }
  }

  return { decision: decideExpiryAction(rows, statuses), sessions }
}

serve(async (_req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey)
  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
    apiVersion: '2024-12-18.acacia',
  })

  const results = {
    reminders_sent: 0,
    reminders_failed: 0,
    reminders_reconciled: 0,
    expired_cancelled: 0,
    expired_failed: 0,
    expired_reconciled: 0,
  }

  try {
    // ── 1. 6h reminder ────────────────────────────────────────────────────
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()

    const { data: reminderBookings, error: reminderError } = await supabase
      .from('booking')
      .select('id')
      .eq('status', 'Pending Payment')
      .lt('created_at', sixHoursAgo)

    if (reminderError) {
      console.error('Reminder query error:', reminderError.message)
    }

    // Filter out bookings that already have a sent/queued reminder
    const reminderCandidates: Array<{ id: string }> = []
    for (const booking of (reminderBookings ?? []) as Array<{ id: string }>) {
      const { data: existingLog } = await supabase
        .from('notification_log')
        .select('id')
        .eq('booking_id', booking.id)
        .eq('notification_type', 'payment_reminder')
        .in('status', ['queued', 'sent'])
        .limit(1)

      if (!existingLog || existingLog.length === 0) {
        reminderCandidates.push(booking)
      }
    }

    for (const booking of reminderCandidates) {
      try {
        // Paid-guard: never dun a customer whose payment already succeeded.
        const { decision, sessions } = await assessBooking(supabase, stripe, booking.id)

        if (decision.action === 'reconcile') {
          const session = sessions.get(decision.sessionId) ??
            await stripe.checkout.sessions.retrieve(decision.sessionId)
          await reconcileCheckoutSession(supabase, stripe, session)
          results.reminders_reconciled++
          continue
        }
        if (decision.action === 'skip') {
          // Unverifiable — don't dun this cycle; visible in the run log.
          results.reminders_failed++
          continue
        }

        const res = await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'payment_reminder',
            booking_id: booking.id,
          }),
        })
        if (res.ok) {
          results.reminders_sent++
        } else {
          results.reminders_failed++
          const body = await res.text().catch(() => '(no body)')
          console.error(`Reminder failed for ${booking.id}: ${body}`)
        }
      } catch (err) {
        results.reminders_failed++
        console.error(`Reminder crashed for ${booking.id}:`, err instanceof Error ? err.message : String(err))
      }
    }

    // ── 2. 24h expiry ─────────────────────────────────────────────────────
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const { data: expiryBookings, error: expiryError } = await supabase
      .from('booking')
      .select('id, client_id, contact_id')
      .eq('status', 'Pending Payment')
      .lt('created_at', twentyFourHoursAgo)

    if (expiryError) {
      console.error('Expiry query error:', expiryError.message)
    }

    for (const booking of (expiryBookings ?? []) as Array<{ id: string; client_id: string; contact_id: string | null }>) {
      try {
        // Paid-guard BEFORE the queued log row: a reconciled booking must
        // never carry a live, resumable "payment expired" notification.
        const { decision, sessions } = await assessBooking(supabase, stripe, booking.id)

        if (decision.action === 'reconcile') {
          const session = sessions.get(decision.sessionId) ??
            await stripe.checkout.sessions.retrieve(decision.sessionId)
          await reconcileCheckoutSession(supabase, stripe, session)
          results.expired_reconciled++
          continue
        }
        if (decision.action === 'skip') {
          // Unverifiable — never cancel on doubt. Counts as a failure so the
          // run returns 500 and the gap is visible to monitoring.
          results.expired_failed++
          console.error(`Expiry skipped for ${booking.id}: unverifiable Stripe session`)
          continue
        }

        // Step 1: Insert queued notification_log row
        const { data: logRow, error: logError } = await supabase
          .from('notification_log')
          .insert({
            booking_id: booking.id,
            client_id: booking.client_id,
            contact_id: booking.contact_id,
            channel: 'email',
            notification_type: 'payment_expired',
            to_address: 'pending',
            status: 'queued',
          })
          .select('id')
          .single()

        if (logError || !logRow) {
          results.expired_failed++
          console.error(`Expiry log insert failed for ${booking.id}:`, logError?.message)
          continue
        }

        // Step 2: Cancel the booking
        const { error: cancelError } = await supabase
          .from('booking')
          .update({
            status: 'Cancelled',
            cancelled_at: new Date().toISOString(),
          })
          .eq('id', booking.id)

        if (cancelError) {
          results.expired_failed++
          console.error(`Expiry cancel failed for ${booking.id}:`, cancelError.message)
          continue
        }

        // Step 3: Dispatch by log_id (crash-safe — queued row persists if this fails)
        const res = await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            notification_log_id: logRow.id,
          }),
        })

        if (res.ok) {
          results.expired_cancelled++
        } else {
          // Booking IS cancelled, log row stays queued for retry
          results.expired_cancelled++
          const body = await res.text().catch(() => '(no body)')
          console.error(`Expiry notification failed for ${booking.id} (booking cancelled, email pending): ${body}`)
        }
      } catch (err) {
        results.expired_failed++
        console.error(`Expiry crashed for ${booking.id}:`, err instanceof Error ? err.message : String(err))
      }
    }

    console.log(JSON.stringify({ event: 'handle_expired_payments', ...results }))

    // Return 500 on any per-row failure so pg_cron logs a non-success HTTP
    // status — otherwise silent partial failures look fine to monitoring.
    const status = results.expired_failed > 0 ? 500 : 200
    const ok = results.expired_failed === 0
    return new Response(JSON.stringify({ ok, ...results }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('handle-expired-payments error:', err)
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
