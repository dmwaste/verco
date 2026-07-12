import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { awstDateFromUtc } from '../_shared/schedule-transition.ts'
import { deleteOrders, getRoutingApiKey } from '../_shared/optimoroute.ts'

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
 * Cancelled stops are swept regardless of pushed_at: if the push EF died
 * between the routing-API call and the pushed_at stamp, the order exists in
 * OptimoRoute with no stamp — filtering on pushed_at would orphan it there
 * forever. Sweeping never-pushed stops is a harmless not-found no-op.
 *
 * Idempotent: not-found (ERR_ORD_NOT_FOUND) counts as success, and
 * external_deleted_at keeps handled stops out of the next run.
 */

serve(async (_req) => {
  const supabase = createClient<Database>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const today = awstDateFromUtc(new Date())
  const results = {
    today_awst: today,
    candidates: 0,
    deleted: 0,
    failed: 0,
  }

  try {
    const candidates: Array<{ id: string; external_order_ref: string }> = []
    for (let from = 0; ; from += 1000) {
      const { data: page, error: fetchError } = await supabase
        .from('collection_stop')
        .select('id, external_order_ref, collection_date!inner(date)')
        .eq('status', 'Cancelled')
        .is('external_deleted_at', null)
        .gte('collection_date.date', today)
        .order('id')
        .range(from, from + 999)
      if (fetchError) throw new Error(`cancelled stops fetch: ${fetchError.message}`)
      candidates.push(...((page ?? []) as Array<{ id: string; external_order_ref: string }>))
      if ((page ?? []).length < 1000) break
    }
    results.candidates = candidates.length

    if (candidates.length > 0) {
      const apiKey = getRoutingApiKey()
      const deleteResults = await deleteOrders(
        apiKey,
        candidates.map((s) => s.external_order_ref),
      )

      const okIds: string[] = []
      for (let i = 0; i < candidates.length; i++) {
        const result = deleteResults[i]
        if (result?.success) {
          okIds.push(candidates[i]!.id)
        } else {
          results.failed++
          console.error(
            `Delete failed for ${candidates[i]!.external_order_ref}: ${result?.error ?? 'no result'}`,
          )
        }
      }

      if (okIds.length > 0) {
        const { error: stampError } = await supabase
          .from('collection_stop')
          .update({ external_deleted_at: new Date().toISOString() })
          .in('id', okIds)
        if (stampError) throw new Error(`external_deleted_at stamp: ${stampError.message}`)
        results.deleted = okIds.length
      }
    }

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
})
