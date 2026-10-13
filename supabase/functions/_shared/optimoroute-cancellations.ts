// EF-only helper — no src/lib mirror (nothing app-side reads it).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from './database.types.ts'
import { deleteOrders, getRoutingApiKey } from './optimoroute.ts'

// A type alias, not an interface, so it stays assignable to Json (sync_log payload).
export type CancellationSweepResult = {
  candidates: number
  deleted: number
  failed: number
}

/**
 * Deletes the OptimoRoute orders behind Cancelled stops dated today (AWST) or
 * later. Shared by the hourly sync-optimoroute-cancellations cron and the
 * nightly send-routes-to-optimoroute run, which sweeps once more right before
 * sharing so a stop cancelled since the last :20 sweep isn't sent to the crews.
 *
 * Cancelled stops are swept regardless of pushed_at: if the push EF died
 * between the routing-API call and the pushed_at stamp, the order exists in
 * OptimoRoute with no stamp — filtering on pushed_at would orphan it there
 * forever. Sweeping never-pushed stops is a harmless not-found no-op.
 *
 * Idempotent: not-found (ERR_ORD_NOT_FOUND) counts as success, and
 * external_deleted_at keeps handled stops out of the next run. Throws on a
 * DB read/stamp failure; per-order OR rejections come back in `failed`.
 */
export async function sweepCancelledOrders(
  supabase: SupabaseClient<Database>,
  today: string,
): Promise<CancellationSweepResult> {
  const results: CancellationSweepResult = { candidates: 0, deleted: 0, failed: 0 }

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

  return results
}
