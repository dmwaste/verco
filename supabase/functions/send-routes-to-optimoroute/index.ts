import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { cronHandler } from '../_shared/cron-handler.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { addOneDay, awstDateFromUtc } from '../_shared/schedule-transition.ts'
import {
  getDispatchStatus,
  getRoutingApiKey,
  type OrDispatchStatus,
  sendRoutes,
} from '../_shared/optimoroute.ts'
import {
  type CancellationSweepResult,
  sweepCancelledOrders,
} from '../_shared/optimoroute-cancellations.ts'
import { logSyncRun } from '../_shared/sync-run-log.ts'

/**
 * send-routes-to-optimoroute cron Edge Function
 *
 * Fires once a day at 20:00 AWST (12:00 UTC). Service role: the pre-send
 * sweep stamps collection_stop.external_deleted_at, a service-role-only write.
 *
 * Shares TOMORROW's routes with the crews — Verco owns the 8pm handover ops
 * used to do (or schedule ahead) with "Share routes" in the OR web UI. A
 * share scheduled ahead froze the routes as they were when it was scheduled,
 * so moves and cancellations made after that never reached the phones
 * (MOS-12984, 12/10/2026). ADR 0028.
 *   1. Final cancellation sweep, so a stop cancelled since the :20 sweep is
 *      out of OptimoRoute before the routes go.
 *   2. Read tomorrow's share state first. A share ops scheduled ahead in the
 *      OR web UI is the MOS-12984 trap — flagged as an error (Sentry), but
 *      the send still goes so the phones get the live plan.
 *   3. send_routes(tomorrow) — whatever is planned right now, with customer
 *      notifications, exactly like the manual share.
 *
 * Sends ONCE. Anything changed after 8pm is re-shared by staff in the OR web
 * UI; this EF never re-sends. A sweep failure doesn't stop the send (the
 * crews still need their routes) — either failure returns 500 for Sentry.
 */

serve(cronHandler('send-routes-to-optimoroute', async (_req) => {
  const supabase = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const today = awstDateFromUtc(new Date())
  const date = addOneDay(today)
  const errors: string[] = []
  let sweep: CancellationSweepResult | null = null
  let send: 'sent' | 'nothing_to_send' | null = null

  try {
    sweep = await sweepCancelledOrders(supabase, today)
    if (sweep.failed > 0) errors.push(`sweep: ${sweep.failed} order delete(s) failed`)
  } catch (err) {
    errors.push(`sweep: ${err instanceof Error ? err.message : String(err)}`)
  }

  let before: OrDispatchStatus | null = null
  try {
    const apiKey = getRoutingApiKey()
    try {
      before = await getDispatchStatus(apiKey, date)
      if (before.state === 'scheduled') {
        errors.push(
          `a share was already scheduled in OptimoRoute for ${before.scheduledForUtc} — ` +
            'cancel scheduled shares; Verco shares at 8pm (ADR 0028)',
        )
      }
    } catch (err) {
      // Diagnostic only — never blocks the send.
      console.error('dispatch status read failed:', err instanceof Error ? err.message : err)
    }
    send = await sendRoutes(apiKey, date)
  } catch (err) {
    errors.push(`send: ${err instanceof Error ? err.message : String(err)}`)
  }

  const results = { date, sweep, before, send, errors }
  console.log(JSON.stringify({ event: 'send_routes_to_optimoroute', ...results }))
  await logSyncRun(
    supabase,
    'send-routes-to-optimoroute',
    errors.length > 0 ? 'failed' : 'success',
    results,
    errors.length > 0 ? errors.join('; ') : undefined,
  )

  return new Response(JSON.stringify({ ok: errors.length === 0, ...results }), {
    status: errors.length > 0 ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
  })
}))
