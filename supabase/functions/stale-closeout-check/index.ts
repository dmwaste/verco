import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { cronHandler } from '../_shared/cron-handler.ts'
import { captureWarning } from '../_shared/sentry.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { awstDateFromUtc } from '../_shared/schedule-transition.ts'
import {
  buildStaleCloseoutAlert,
  DEFAULT_STALE_THRESHOLD_DAYS,
  evaluateStaleCloseouts,
  staleCutoffDate,
  type LiveBookingRow,
  type StopRow,
} from '../_shared/stale-closeouts.ts'
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
 * stale-closeout-check Edge Function (#575)
 *
 * Daily watchdog (pg_cron, 09:35 AWST) over field closeouts. Cambridge ran 204
 * dispatched stops and closed out none for two weeks before anyone noticed
 * (#568): unclosed stops are unbilled work and under-report the contractual
 * on-time KPI (ADR 0009). This names, once, each collection day that is now
 * `STALE_CLOSEOUT_THRESHOLD_DAYS` past with stops still open, plus any
 * `Scheduled` booking left with no open stop (not dispatched), and restates the standing
 * backlog. Detection + wording + the re-alert rule live in the pure
 * `_shared/stale-closeouts.ts` (unit-tested via its `src/lib/ops/` mirror).
 *
 * ## Re-alerting
 *
 * Stateless: the cohort is the stops dated exactly `today − threshold`, i.e.
 * what went stale since yesterday's run. A day with only the old backlog is
 * quiet, except Mondays, when the backlog is restated so it can't drop out of
 * sight. Re-running on the same day gives the same answer.
 *
 * ## Queries
 *
 * Paginated PostgREST reads + per-area head counts rather than a bespoke RPC:
 * `collection_stop` is ~10k rows in total, and a new RPC + its consumer can't
 * ship in one PR (Types Freshness gens from prod). Every list query carries a
 * stable `.order('id')` (prod caps a response at 1000 rows).
 *
 * ## Requests
 *
 *   `{}`                    — the cron run.
 *   `{ "test_alert": true }` — skip the check, send the runbook's test message.
 *   `{ "dry_run": true }`    — run the check and return the alert it WOULD send,
 *                              without posting it (prod verification without a
 *                              Teams message).
 *
 * All through `cronHandler`: X-Cron-Secret or a service-role bearer.
 *
 * ## Auth
 *
 * Service-role only, cron-invoked; the privileged reads use the function's own
 * SUPABASE_SERVICE_ROLE_KEY env. Read-only apart from the outbound alert.
 *
 * ## Config (Edge Function secrets / env)
 *
 *   OPS_ALERT_WEBHOOK_URL            the ops sink (#576); absent → the check
 *                                    still runs + logs, no POST, Sentry warning
 *   OPS_ALERT_WEBHOOK_FORMAT         `teams` (default) | `slack`
 *   STALE_CLOSEOUT_THRESHOLD_DAYS    default 3 — days past collection before a
 *                                    stop counts as stale
 *
 * ## Return contract
 *
 *   200 — check ran (alerted or not; an unset URL stays 200 — a config gap,
 *         reported to Sentry instead)
 *   500 — a DB read failed, or an alert was warranted but the webhook POST
 *         failed / OPS_ALERT_WEBHOOK_FORMAT is invalid. A failed closed-out
 *         count still sends the alert ("count unknown"), then returns 500.
 *   test alert: 200 when the webhook accepted it, 500 otherwise.
 */

const SOURCE = 'stale-closeout-check'

const CLOSED_OUT_STATUSES = ['Completed', 'Non-conformance', 'Nothing Presented'] as const

const STOP_SELECT = 'id, booking_id, status, collection_date!inner(date, collection_area_id, collection_area!inner(code))'

function intFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

serve(cronHandler(SOURCE, async (req) => {
  const sinkConfig: OpsAlertConfig = {
    webhookUrl: Deno.env.get('OPS_ALERT_WEBHOOK_URL'),
    format: Deno.env.get('OPS_ALERT_WEBHOOK_FORMAT'),
  }

  // pg_cron posts `{}`; the runbook posts `{ "test_alert": true }` / `{ "dry_run": true }`.
  const body: unknown = await req.json().catch(() => null)
  if (isTestAlertRequest(body)) {
    const result = await sendOpsAlert(buildTestAlert(SOURCE), sinkConfig, { captureWarning })
    console.log(`${SOURCE}: test alert`, JSON.stringify(result))
    return jsonResponse({ ok: result.delivered, test_alert: true, ...result }, result.delivered ? 200 : 500)
  }
  const dryRun = typeof body === 'object' && body !== null && (body as { dry_run?: unknown }).dry_run === true

  const supabase = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const today = awstDateFromUtc(new Date())
  const thresholdDays = intFromEnv('STALE_CLOSEOUT_THRESHOLD_DAYS', DEFAULT_STALE_THRESHOLD_DAYS)
  const cohortDate = staleCutoffDate(today, thresholdDays)

  try {
    // 1. Stops dated on the cohort date (any outcome but Cancelled) — the day
    //    that went stale since yesterday.
    const cohort = await fetchAllPages((from, to) =>
      supabase
        .from('collection_stop')
        .select(STOP_SELECT)
        .neq('status', 'Cancelled')
        .eq('collection_date.date', cohortDate)
        .order('id', { ascending: true })
        .range(from, to),
    )
    if (!cohort.ok) return readFailed('cohort stops', cohort.error)

    // 2. Every still-open stop on or before the cohort date — the backlog.
    const open = await fetchAllPages((from, to) =>
      supabase
        .from('collection_stop')
        .select(STOP_SELECT)
        .eq('status', 'Pending')
        .lte('collection_date.date', cohortDate)
        .order('id', { ascending: true })
        .range(from, to),
    )
    if (!open.ok) return readFailed('open stops', open.error)

    // 3. Scheduled bookings + their stops' statuses (not dispatched = no
    //    Pending stop; a Cancelled one left by a date move doesn't count, #486).
    const scheduled = await fetchAllPages((from, to) =>
      supabase
        .from('booking')
        .select('id, collection_area!inner(code), booking_item(collection_date(date)), collection_stop(status)')
        .eq('status', 'Scheduled')
        .order('id', { ascending: true })
        .range(from, to),
    )
    if (!scheduled.ok) return readFailed('scheduled bookings', scheduled.error)

    const toStopRow = (s: (typeof cohort.rows)[number]): StopRow => ({
      areaId: s.collection_date.collection_area_id,
      areaCode: s.collection_date.collection_area.code,
      date: s.collection_date.date,
      status: s.status,
      bookingId: s.booking_id,
    })
    const liveBookings: LiveBookingRow[] = scheduled.rows.map((b) => ({
      areaCode: b.collection_area.code,
      dates: b.booking_item
        .map((i) => i.collection_date?.date)
        .filter((d): d is string => typeof d === 'string'),
      stopStatuses: b.collection_stop.map((s) => s.status),
    }))

    const report = evaluateStaleCloseouts({
      today,
      thresholdDays,
      cohortStops: cohort.rows.map(toStopRow),
      openStops: open.rows.map(toStopRow),
      liveBookings,
    })

    // Area codes + counts only — no booking ids or refs in logs either.
    const summary = {
      today,
      threshold_days: thresholdDays,
      cohort_date: report.cohortDate,
      trigger: report.trigger,
      newly_stale: report.newlyStale,
      newly_not_dispatched: report.newlyNotDispatched.length,
      backlog_totals: report.totals,
      backlog: report.backlog.map((a) => ({
        area: a.areaCode,
        open_stops: a.openStops,
        bookings: a.bookings,
        oldest: a.oldestDate,
        newest: a.newestDate,
      })),
    }
    console.log(`${SOURCE}:`, JSON.stringify(summary))

    if (report.trigger === null) {
      // Nothing to say — but a watchdog that can't speak is itself a fault (#576).
      const sink = resolveOpsAlertSink(sinkConfig)
      if (!sink.ok && !dryRun) {
        console.warn(`${SOURCE}: nothing stale, but the watchdog cannot alert — ${sink.error}`)
        captureWarning(`${SOURCE}: the watchdog cannot alert — ${sink.error}`, { reason: sink.reason })
      }
      return jsonResponse({ ok: true, alerted: false, dry_run: dryRun, ...summary }, 200)
    }

    // 4. Context for the alert: closeouts each backlog area recorded since its
    //    oldest open stop ("0 since 31/08" = the area has gone dark). Counted
    //    only on alert days. A failed count still lets the alert go out.
    const closedOutSince: Record<string, number> = {}
    const countErrors: string[] = []
    await Promise.all(report.backlog.map(async (a) => {
      const { count, error } = await supabase
        .from('collection_stop')
        .select('id, collection_date!inner(date, collection_area_id)', { count: 'exact', head: true })
        .in('status', [...CLOSED_OUT_STATUSES])
        .eq('collection_date.collection_area_id', a.areaId)
        .gte('collection_date.date', a.oldestDate)
        .lte('collection_date.date', report.cohortDate)
      if (error || count === null) countErrors.push(`${a.areaCode}: ${error?.message ?? 'no count returned'}`)
      else closedOutSince[a.areaId] = count
    }))
    if (countErrors.length > 0) console.error(`${SOURCE}: closed-out count failed`, countErrors)

    const content = buildStaleCloseoutAlert(report, { adminOrigin: ADMIN_ORIGIN, closedOutSince })!
    const alert: OpsAlert = { source: SOURCE, ...content }

    if (dryRun) {
      return jsonResponse(
        { ok: countErrors.length === 0, alerted: false, dry_run: true, alert_text: opsAlertText(alert), count_errors: countErrors, ...summary },
        countErrors.length === 0 ? 200 : 500,
      )
    }

    const result = await sendOpsAlert(alert, sinkConfig, { captureWarning })
    const countFailure = countErrors.length > 0 ? `closed-out count failed — ${countErrors.join('; ')}` : null

    if (result.delivered) {
      console.log(`${SOURCE}: alert sent`, JSON.stringify({ trigger: report.trigger, cohort_date: report.cohortDate }))
      if (countFailure) return jsonResponse({ ok: false, alerted: true, error: countFailure, ...summary }, 500)
      return jsonResponse({ ok: true, alerted: true, ...summary }, 200)
    }

    console.warn(`${SOURCE}: alert NOT sent — ${result.error}\n${opsAlertText(alert)}`)
    if (result.reason === 'not_configured' && !countFailure) {
      // A config gap, not a per-run failure — sendOpsAlert already raised the
      // Sentry warning that makes it visible.
      return jsonResponse({ ok: true, alerted: false, alert_skipped: result.error, ...summary }, 200)
    }
    const errors = [`alert not sent: ${result.error}`, countFailure].filter(Boolean).join('; ')
    return jsonResponse({ ok: false, alerted: false, error: errors, ...summary }, 500)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`${SOURCE}: uncaught`, error)
    return jsonResponse({ ok: false, error: `uncaught: ${error}` }, 500)
  }
}))

function readFailed(what: string, error: string): Response {
  console.error(`${SOURCE}: ${what} query failed`, error)
  return jsonResponse({ ok: false, error: `${what} query failed: ${error}` }, 500)
}

/** PostgREST page size on prod (max-rows); a longer result is silently cut. */
const PAGE_SIZE = 1000

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/**
 * Drain an ordered query page by page. The caller's query MUST carry a stable
 * `.order()` — `.range()` without one skips and duplicates rows across pages.
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
