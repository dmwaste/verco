import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { cronHandler } from '../_shared/cron-handler.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { awstDateFromUtc } from '../_shared/schedule-transition.ts'
import { sweepCancelledOrders } from '../_shared/optimoroute-cancellations.ts'

/**
 * sync-optimoroute-cancellations cron Edge Function
 *
 * Fires hourly (xx:20 UTC). Service role only.
 *
 * The DB trigger sync_stops_on_booking_status cancels Pending stops the
 * moment a booking is cancelled — by any path (resident, admin,
 * handle-expired-payments). This sweep is the OptimoRoute-side reconciler:
 * it deletes the routing-engine orders for cancelled stops, covering the
 * T-3 → day-prior-cutoff cancellation window. The date filter (>= today
 * AWST) self-bounds the sweep; past dates age out naturally.
 *
 * The sweep itself lives in _shared/optimoroute-cancellations.ts — the
 * nightly send-routes-to-optimoroute run calls it too, right before sharing.
 */

serve(cronHandler('sync-optimoroute-cancellations', async (_req) => {
  const supabase = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const today = awstDateFromUtc(new Date())

  try {
    const results = { today_awst: today, ...(await sweepCancelledOrders(supabase, today)) }

    console.log(JSON.stringify({ event: 'sync_optimoroute_cancellations', ...results }))

    const status = results.failed > 0 ? 500 : 200
    return new Response(JSON.stringify({ ok: results.failed === 0, ...results }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('sync-optimoroute-cancellations error:', err)
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}))
