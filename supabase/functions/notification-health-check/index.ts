import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import {
  buildHealthAlert,
  findUnhealthyChannels,
  type ChannelWindowStats,
  type HealthThresholds,
  type NotificationChannel,
} from '../_shared/notification-health.ts'

/**
 * notification-health-check Edge Function (VER-254)
 *
 * Watchdog over `notification_log`. Runs on pg_cron (every 3h). For each
 * channel (email, sms) it tallies sends in a trailing window and, if the
 * channel looks unhealthy (failure spike, or fully dark with failures), posts
 * an alert to an ops webhook.
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
 * The alert goes to `OPS_ALERT_WEBHOOK_URL` (a Slack-compatible incoming
 * webhook, or any sink that accepts `{ text }`). This is deliberately
 * independent of both SendGrid (email) and Twilio (SMS) — alerting about a
 * dead email channel must not depend on that same email channel.
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
 *                                  absent → the check still runs + logs, no POST
 *   NOTIF_HEALTH_WINDOW_HOURS      default 3
 *   NOTIF_HEALTH_FAILURE_THRESHOLD default 3
 *
 * ## Return contract
 *
 *   200 — check ran (whether or not channels were unhealthy / an alert sent)
 *   500 — the DB read failed, or an alert was warranted but the webhook POST
 *         failed (so pg_cron records a non-success HTTP status — a 200 would
 *         hide a broken alert path, exactly the silent-failure trap we're
 *         closing).
 */

const CHANNELS: NotificationChannel[] = ['email', 'sms']

function intFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

serve(async (_req) => {
  const supabase = createClient(
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
    //    gives "last good" context in the alert. One small bounded query.
    const { data: recentSent, error: sentErr } = await supabase
      .from('notification_log')
      .select('channel, created_at')
      .eq('status', 'sent')
      .order('created_at', { ascending: false })
      .limit(50)

    if (sentErr) {
      console.error('notification-health-check: last-success query failed', sentErr.message)
      return jsonResponse({ ok: false, error: sentErr.message }, 500)
    }

    const lastSuccessByChannel = new Map<string, string>()
    for (const row of recentSent ?? []) {
      const ch = row.channel as string
      if (!lastSuccessByChannel.has(ch)) {
        lastSuccessByChannel.set(ch, row.created_at as string)
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
    const summary = {
      window_hours: thresholds.windowHours,
      failure_threshold: thresholds.failureThreshold,
      channels: stats.map((s) => ({
        channel: s.channel,
        sent: s.sent,
        failed: s.failed,
      })),
      unhealthy: unhealthy.map((u) => u.channel),
    }
    console.log('notification-health-check:', JSON.stringify(summary))

    if (unhealthy.length === 0) {
      return jsonResponse({ ok: true, alerted: false, ...summary }, 200)
    }

    // 4. Unhealthy → alert via the channel-independent webhook.
    const message = buildHealthAlert(unhealthy, thresholds)!
    const webhookUrl = Deno.env.get('OPS_ALERT_WEBHOOK_URL')

    if (!webhookUrl) {
      // No sink configured. Still surface loudly in the EF logs and report
      // back — but this is a config gap, not a per-run failure, so 200.
      console.warn(
        'notification-health-check: unhealthy channel(s) detected but ' +
          'OPS_ALERT_WEBHOOK_URL is not set — no alert sent.\n' +
          message,
      )
      return jsonResponse(
        { ok: true, alerted: false, alert_skipped: 'OPS_ALERT_WEBHOOK_URL not set', ...summary },
        200,
      )
    }

    let postRes: Response
    try {
      postRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      })
    } catch (postErr) {
      const error = postErr instanceof Error ? postErr.message : String(postErr)
      console.error('notification-health-check: alert webhook POST threw', error)
      return jsonResponse({ ok: false, error: `alert webhook failed: ${error}`, ...summary }, 500)
    }

    if (!postRes.ok) {
      const body = await postRes.text().catch(() => '')
      console.error(
        `notification-health-check: alert webhook returned ${postRes.status}`,
        body,
      )
      return jsonResponse(
        { ok: false, error: `alert webhook returned ${postRes.status}`, ...summary },
        500,
      )
    }

    console.log('notification-health-check: alert sent for', summary.unhealthy)
    return jsonResponse({ ok: true, alerted: true, ...summary }, 200)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('notification-health-check: uncaught', error)
    return jsonResponse({ ok: false, error: `uncaught: ${error}` }, 500)
  }
})

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
