import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { awstDateFromUtc } from '../_shared/schedule-transition.ts'
import {
  getRoutingApiKey,
  updateCompletionDetails,
  type OrCompletionInput,
} from '../_shared/optimoroute.ts'
import { logSyncRun } from '../_shared/sync-run-log.ts'

/**
 * sync-completions-to-optimoroute cron Edge Function
 *
 * Reports Verco closeouts back to OptimoRoute so OR advances its route and runs
 * its customer notifications (the "~30 min away" ETA email + completion
 * receipt). Crews close stops out in Verco's field UI (Completed /
 * Non-conformance / Nothing Presented); OR only needs "done", so every terminal
 * outcome is reported as status='success' — Verco stays the source of truth for
 * the real outcome.
 *
 * Service role only, no bearer gate (like push/sync-cancellations). Runs every
 * 5 min: idempotent sweep of terminal stops pushed to OR but not yet reported
 * complete, bounded to a short recent window so a first run never tries to
 * "complete" thousands of ancient orders that no longer exist in OR.
 */

// Terminal stop statuses reported complete to OR.
const TERMINAL_STATUSES = ['Completed', 'Non-conformance', 'Nothing Presented'] as const
// Only look back a couple of days — completions happen on the collection day;
// this catches late/next-morning closeouts without scanning historical orders.
const LOOKBACK_DAYS = 2
const PAGE_SIZE = 500

interface TerminalStopRow {
  id: string
  external_order_ref: string
  collection_date: { date: string }
}

/** yyyy-MM-dd minus n days, via UTC date math (timezone-agnostic on a date). */
function minusDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

serve(async (_req) => {
  const supabase = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const today = awstDateFromUtc(new Date())
  const fromDate = minusDays(today, LOOKBACK_DAYS)
  const results = { today_awst: today, from_date: fromDate, synced: 0, failed: 0 }

  try {
    const apiKey = getRoutingApiKey()

    // Terminal stops pushed to OR, not yet reported complete, recent window.
    const stops: TerminalStopRow[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data: page, error } = await supabase
        .from('collection_stop')
        .select('id, external_order_ref, collection_date!inner(date)')
        .in('status', TERMINAL_STATUSES)
        .not('external_order_ref', 'is', null)
        .not('pushed_at', 'is', null)
        .is('completion_synced_at', null)
        .gte('collection_date.date', fromDate)
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw new Error(`terminal stops fetch: ${error.message}`)
      stops.push(...((page ?? []) as unknown as TerminalStopRow[]))
      if ((page ?? []).length < PAGE_SIZE) break
    }

    if (stops.length > 0) {
      const completions: OrCompletionInput[] = stops.map((s) => ({
        orderNo: s.external_order_ref,
        status: 'success',
      }))

      const orderResults = await updateCompletionDetails(apiKey, completions)

      const okIds: string[] = []
      for (let i = 0; i < stops.length; i++) {
        const result = orderResults[i]
        if (result?.success) {
          okIds.push(stops[i]!.id)
        } else {
          results.failed++
          console.error(
            `Completion sync failed for ${stops[i]!.external_order_ref}: ${result?.error ?? 'no result'}`,
          )
        }
      }

      if (okIds.length > 0) {
        const { error: stampError } = await supabase
          .from('collection_stop')
          .update({ completion_synced_at: new Date().toISOString() })
          .in('id', okIds)
        if (stampError) throw new Error(`completion_synced_at stamp: ${stampError.message}`)
        results.synced = okIds.length
      }
    }

    console.log(JSON.stringify({ event: 'sync_completions_to_optimoroute', ...results }))

    // Durable outcome row — but only for ticks that did (or failed to do)
    // work: this cron fires every 5 minutes, and a no-op tick is not signal.
    // Cron liveness is visible in cron.job_run_details; what needs a durable
    // record is each actual sync and each failure (see logSyncRun).
    if (results.synced > 0 || results.failed > 0) {
      await logSyncRun(
        supabase,
        'sync-completions-to-optimoroute',
        results.failed > 0 ? 'failed' : 'success',
        results,
      )
    }

    // 500 on any per-order failure so pg_cron monitoring sees it.
    const status = results.failed > 0 ? 500 : 200
    return new Response(JSON.stringify({ ok: results.failed === 0, ...results }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('sync-completions-to-optimoroute error:', err)
    await logSyncRun(
      supabase,
      'sync-completions-to-optimoroute',
      'failed',
      results,
      err instanceof Error ? err.message : String(err),
    )
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
})
