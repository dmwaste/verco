import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { cronHandler } from '../_shared/cron-handler.ts'
import { captureWarning } from '../_shared/sentry.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { jsonResponse } from '../_shared/cors.ts'
import { intFromEnv } from '../_shared/env.ts'
import { fetchAllPages } from '../_shared/postgrest-pages.ts'
import {
  buildHealthAlert,
  findMissingConfirmations,
  findUnhealthyChannels,
  MISSING_CONFIRMATION_SETTLE_MINUTES,
  settledConfirmationBookingIds,
  type ChannelWindowStats,
  type ConfirmationCandidate,
  type HealthThresholds,
  type NotificationChannel,
} from '../_shared/notification-health.ts'
import {
  ADMIN_ORIGIN,
  buildTestAlert,
  isTestAlertRequest,
  opsAlertText,
  resolveOpsAlertSink,
  sendOpsAlert,
  type OpsAlert,
  type OpsAlertConfig,
} from '../_shared/ops-alert.ts'

/**
 * notification-health-check Edge Function (VER-254)
 *
 * Watchdog over `notification_log`. Runs on pg_cron (every 3h). For each
 * channel (email, sms) it tallies sends in a trailing window and, if the
 * channel looks unhealthy (failure spike, or fully dark with failures), posts
 * an alert to an ops webhook.
 *
 * It also runs the missing-confirmation backstop (18/10/2026): every live
 * resident/admin booking created in the lookback window and older than
 * MISSING_CONFIRMATION_SETTLE_MINUTES must have a `sent` or `failed`
 * `booking_created` row (a `queued` send claim left by a dispatcher that died
 * mid-send doesn't count, #671). Two live bookings (MOS-JOZCOM, KWN-2-I2NA9E) had none — the
 * EF→EF hop 502'd before a worker ran, so the channel tallies above saw
 * nothing. The invoke helper now retries + records a `failed` row; this
 * catches whatever it can't (create-booking crashing between RPC and notify).
 *
 * ## Why this exists
 *
 * Two silent multi-day notification outages (14 Apr `verify_jwt`; 18 May
 * SendGrid key revocation) only surfaced via manual QA. A failed send writes a
 * `failed` row and the caller swallows it (fire-and-forget). Nothing watched
 * the table — this does.
 *
 * ## Alert path independence
 *
 * The alert goes through `sendOpsAlert` (`_shared/ops-alert.ts`, #576) to
 * `OPS_ALERT_WEBHOOK_URL` — a Teams Workflows webhook by default, or a
 * `{ text }` (Slack-style) sink with OPS_ALERT_WEBHOOK_FORMAT=slack. This is
 * deliberately independent of both SendGrid (email) and Twilio (SMS) — alerting
 * about a dead email channel must not depend on that same email channel.
 *
 * Until #576 the URL was never set: the check found problems, logged them and
 * returned 200, unseen for three months. Now a missing or broken sink raises a
 * Sentry warning on EVERY run (healthy runs included), so the gap is visible
 * before the next incident needs it. Runbook: docs/runbooks/ops-alerts.md.
 *
 * ## Test alert
 *
 * POST `{ "test_alert": true }` (through the same cron gate — X-Cron-Secret or
 * a service-role bearer) skips the checks, sends a clearly labelled test
 * message through the sink, and returns what the webhook answered.
 *
 * ## Auth
 *
 * Service-role only, cron-invoked (the incoming bearer is just a routing token
 * for verify_jwt=false; the privileged work uses the function's own
 * SUPABASE_SERVICE_ROLE_KEY env). No user-facing surface. Mirrors
 * `auto-close-notices`.
 *
 * ## Config (Edge Function secrets / env)
 *
 *   OPS_ALERT_WEBHOOK_URL          required for alerts to actually send;
 *                                  absent → the check still runs + logs, no
 *                                  POST, and a Sentry warning names the secret
 *   OPS_ALERT_WEBHOOK_FORMAT       `teams` (default) | `slack`
 *   NOTIF_HEALTH_WINDOW_HOURS      default 3
 *   NOTIF_HEALTH_FAILURE_THRESHOLD default 3
 *   NOTIF_HEALTH_MISSING_CONFIRMATION_HOURS
 *                                  default 24 — lookback for the backstop. A
 *                                  miss is re-alerted every run until it ages
 *                                  out or a sent/failed booking_created row
 *                                  exists, i.e. until someone resends it.
 *
 * ## Return contract
 *
 *   200 — check ran (whether or not channels were unhealthy / an alert sent;
 *         an unset URL stays 200 — a config gap, reported to Sentry instead)
 *   500 — the DB read failed, or an alert was warranted but the webhook POST
 *         failed or OPS_ALERT_WEBHOOK_FORMAT is invalid (so pg_cron records a
 *         non-success HTTP status — a 200 would hide a broken alert path,
 *         exactly the silent-failure trap we're closing)
 *   test alert: 200 when the webhook accepted it, 500 otherwise.
 */

const SOURCE = 'notification-health-check'

const CHANNELS: NotificationChannel[] = ['email', 'sms']

serve(cronHandler(SOURCE, async (req) => {
  const sinkConfig: OpsAlertConfig = {
    webhookUrl: Deno.env.get('OPS_ALERT_WEBHOOK_URL'),
    format: Deno.env.get('OPS_ALERT_WEBHOOK_FORMAT'),
  }

  // pg_cron posts `{}`; the runbook's test posts `{ "test_alert": true }`.
  const body: unknown = await req.json().catch(() => null)
  if (isTestAlertRequest(body)) {
    const result = await sendOpsAlert(buildTestAlert(SOURCE), sinkConfig, { captureWarning })
    console.log(`${SOURCE}: test alert`, JSON.stringify(result))
    return jsonResponse({ ok: result.delivered, test_alert: true, ...result }, result.delivered ? 200 : 500)
  }

  const supabase = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const thresholds: HealthThresholds = {
    windowHours: intFromEnv('NOTIF_HEALTH_WINDOW_HOURS', 3),
    failureThreshold: intFromEnv('NOTIF_HEALTH_FAILURE_THRESHOLD', 3),
  }

  const cutoff = new Date(
    Date.now() - thresholds.windowHours * 60 * 60 * 1000,
  ).toISOString()

  try {
    // 1. Pull every send attempt in the window. Volume per window is tiny
    //    (a handful of bookings), so aggregating in JS beats a bespoke RPC +
    //    the migration/types dance a SQL group-by would require.
    const { data: windowRows, error: windowErr } = await supabase
      .from('notification_log')
      .select('channel, status, error_message, created_at')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })

    if (windowErr) {
      console.error('notification-health-check: window query failed', windowErr.message)
      return jsonResponse({ ok: false, error: windowErr.message }, 500)
    }

    // 2. Most-recent successful send per channel (may predate the window) —
    //    gives "last good" context in the alert. Queried per channel rather
    //    than one capped query over all channels: a chatty channel could
    //    otherwise push a quiet channel's last success out of the result set
    //    and mislabel it "never".
    const lastSuccessByChannel = new Map<string, string>()
    for (const channel of CHANNELS) {
      const { data: lastSent, error: sentErr } = await supabase
        .from('notification_log')
        .select('created_at')
        .eq('channel', channel)
        .eq('status', 'sent')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (sentErr) {
        console.error(
          `notification-health-check: last-success query failed for ${channel}`,
          sentErr.message,
        )
        return jsonResponse({ ok: false, error: sentErr.message }, 500)
      }
      if (lastSent) {
        lastSuccessByChannel.set(channel, lastSent.created_at as string)
      }
    }

    // 3. Build per-channel stats for the pure evaluator.
    const stats: ChannelWindowStats[] = CHANNELS.map((channel) => {
      const rows = (windowRows ?? []).filter((r) => r.channel === channel)
      const sent = rows.filter((r) => r.status === 'sent').length
      const failedRows = rows.filter((r) => r.status === 'failed')
      // windowRows is ordered created_at desc, so the first failed row is newest.
      const lastErrorMessage =
        (failedRows[0]?.error_message as string | null | undefined) ?? null
      return {
        channel,
        sent,
        failed: failedRows.length,
        lastErrorMessage,
        lastSuccessAt: lastSuccessByChannel.get(channel) ?? null,
      }
    })

    const unhealthy = findUnhealthyChannels(stats, thresholds)

    // 3b. Missing-confirmation backstop. Candidates = live bookings a resident
    //     or staff member created (created_via resident/admin — rebooks from a
    //     notice default to 'system' and send booking_updated instead; imports
    //     are 'legacy'), not Illegal Dumping (never notified, #264), inside the
    //     lookback and past the settle period. Diffed in JS against the
    //     booking_created rows in the same window — a sent or failed row
    //     counts as attempted (a lone `queued` claim does not, #671). Both reads paginate: PostgREST caps a page at 1,000 rows
    //     and a silent truncation here would hide the exact bookings we want.
    const missingLookbackHours = intFromEnv('NOTIF_HEALTH_MISSING_CONFIRMATION_HOURS', 24)
    const lookbackIso = new Date(Date.now() - missingLookbackHours * 60 * 60 * 1000).toISOString()
    const settledIso = new Date(
      Date.now() - MISSING_CONFIRMATION_SETTLE_MINUTES * 60 * 1000,
    ).toISOString()

    const candidates = await fetchAllPages<ConfirmationCandidate>((from, to) =>
      supabase
        .from('booking')
        .select('id, ref')
        .in('created_via', ['resident', 'admin'])
        .in('status', ['Submitted', 'Confirmed', 'Scheduled'])
        .neq('type', 'Illegal Dumping')
        .gte('created_at', lookbackIso)
        .lte('created_at', settledIso)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
    if (!candidates.ok) {
      console.error('notification-health-check: candidate bookings query failed', candidates.error)
      return jsonResponse({ ok: false, error: candidates.error }, 500)
    }

    const notified = await fetchAllPages<{ booking_id: string | null; status: string }>((from, to) =>
      supabase
        .from('notification_log')
        .select('booking_id, status')
        .eq('notification_type', 'booking_created')
        .gte('created_at', lookbackIso)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
    if (!notified.ok) {
      console.error('notification-health-check: booking_created log query failed', notified.error)
      return jsonResponse({ ok: false, error: notified.error }, 500)
    }

    // Only sent/failed rows count: a booking whose only row is a stranded
    // `queued` send claim (#671) was never confirmed.
    const notifiedIds = settledConfirmationBookingIds(notified.rows)
    const missingConfirmations = findMissingConfirmations(candidates.rows, notifiedIds)

    const summary = {
      window_hours: thresholds.windowHours,
      failure_threshold: thresholds.failureThreshold,
      channels: stats.map((s) => ({
        channel: s.channel,
        sent: s.sent,
        failed: s.failed,
      })),
      unhealthy: unhealthy.map((u) => u.channel),
      missing_confirmation_lookback_hours: missingLookbackHours,
      missing_confirmation_candidates: candidates.rows.length,
      missing_confirmations: missingConfirmations.length,
      missing_confirmation_refs: missingConfirmations,
    }
    console.log('notification-health-check:', JSON.stringify(summary))

    if (unhealthy.length === 0 && missingConfirmations.length === 0) {
      // Healthy — but a watchdog that can't speak is itself a fault (#576):
      // say so every run until the sink is fixed, not only mid-incident.
      const sink = resolveOpsAlertSink(sinkConfig)
      if (!sink.ok) {
        console.warn(`${SOURCE}: healthy, but the watchdog cannot alert — ${sink.error}`)
        captureWarning(`${SOURCE}: the watchdog cannot alert — ${sink.error}`, { reason: sink.reason })
      }
      return jsonResponse({ ok: true, alerted: false, ...summary }, 200)
    }

    // 4. Unhealthy and/or missing confirmations → alert via the
    //    channel-independent ops sink. Counts, channels and booking refs only
    //    (sendOpsAlert also scrubs emails/phones from the provider error text).
    const message = buildHealthAlert(unhealthy, thresholds, missingConfirmations)!
    const [title = 'Verco notification health alert', ...lines] = message.split('\n')
    const alert: OpsAlert = {
      source: SOURCE,
      title,
      lines,
      links: [{ label: 'Notification log', url: `${ADMIN_ORIGIN}/admin/notifications` }],
    }
    const result = await sendOpsAlert(alert, sinkConfig, { captureWarning })

    if (result.delivered) {
      console.log(
        `${SOURCE}: alert sent for`,
        JSON.stringify({ unhealthy: summary.unhealthy, missing_confirmations: summary.missing_confirmations }),
      )
      return jsonResponse({ ok: true, alerted: true, ...summary }, 200)
    }

    console.warn(`${SOURCE}: alert NOT sent — ${result.error}\n${opsAlertText(alert)}`)
    if (result.reason === 'not_configured') {
      // A config gap, not a per-run failure, so 200 — sendOpsAlert has already
      // raised the Sentry warning that makes it visible.
      return jsonResponse({ ok: true, alerted: false, alert_skipped: result.error, ...summary }, 200)
    }
    return jsonResponse(
      { ok: false, alerted: false, error: `alert not sent: ${result.error}`, ...summary },
      500,
    )
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('notification-health-check: uncaught', error)
    return jsonResponse({ ok: false, error: `uncaught: ${error}` }, 500)
  }
}))
