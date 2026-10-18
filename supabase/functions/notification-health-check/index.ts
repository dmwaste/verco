import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { cronHandler } from '../_shared/cron-handler.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import {
  buildHealthAlert,
  findMissingConfirmations,
  findUnhealthyChannels,
  MISSING_CONFIRMATION_SETTLE_MINUTES,
  type ChannelWindowStats,
  type ConfirmationCandidate,
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
 * It also runs the missing-confirmation backstop (18/10/2026): every live
 * resident/admin booking created in the lookback window and older than
 * MISSING_CONFIRMATION_SETTLE_MINUTES must have a `booking_created` row of
 * ANY status. Two live bookings (MOS-JOZCOM, KWN-2-I2NA9E) had none — the
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
 *   NOTIF_HEALTH_MISSING_CONFIRMATION_HOURS
 *                                  default 24 — lookback for the backstop. A
 *                                  miss is re-alerted every run until it ages
 *                                  out or a booking_created row (any status)
 *                                  exists, i.e. until someone resends it.
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

serve(cronHandler('notification-health-check', async (_req) => {
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
    //     booking_created rows in the same window — any status counts as
    //     attempted. Both reads paginate: PostgREST caps a page at 1,000 rows
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

    const notified = await fetchAllPages<{ booking_id: string | null }>((from, to) =>
      supabase
        .from('notification_log')
        .select('booking_id')
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

    const notifiedIds = new Set(
      notified.rows.map((r) => r.booking_id).filter((id): id is string => typeof id === 'string'),
    )
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
      return jsonResponse({ ok: true, alerted: false, ...summary }, 200)
    }

    // 4. Unhealthy and/or missing confirmations → alert via the
    //    channel-independent webhook.
    const message = buildHealthAlert(unhealthy, thresholds, missingConfirmations)!
    const webhookUrl = Deno.env.get('OPS_ALERT_WEBHOOK_URL')

    if (!webhookUrl) {
      // No sink configured. Still surface loudly in the EF logs and report
      // back — but this is a config gap, not a per-run failure, so 200.
      console.warn(
        'notification-health-check: unhealthy channel(s) / missing confirmation(s) detected but ' +
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

    console.log(
      'notification-health-check: alert sent for',
      JSON.stringify({ unhealthy: summary.unhealthy, missing_confirmations: summary.missing_confirmations }),
    )
    return jsonResponse({ ok: true, alerted: true, ...summary }, 200)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('notification-health-check: uncaught', error)
    return jsonResponse({ ok: false, error: `uncaught: ${error}` }, 500)
  }
}))

/** PostgREST page size on prod (max-rows); a longer result is silently cut. */
const PAGE_SIZE = 1000

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/**
 * Drain an ordered query page by page. The caller's query MUST carry a stable
 * `.order()` (created_at, id) — `.range()` without one skips and duplicates
 * rows across pages (memory supabase-range-pagination-order.md).
 */
async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<{ ok: true; rows: T[] } | { ok: false; error: string }> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) return { ok: false, error: error.message }
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE_SIZE) return { ok: true, rows }
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
