// EF-only helper — no src/lib mirror (nothing app-side reads it at build time).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database, Json } from './database.types.ts'

/** Run-level rows have no per-entity subject; sync_log.entity_id is NOT NULL. */
const RUN_LEVEL_ENTITY_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Persists a per-run outcome row to sync_log. pg_cron's job_run_details only
 * records the net.http_post enqueue and net._http_response TTLs out in ~6h,
 * so without this a cron EF run that died overnight is invisible by morning —
 * the 12–13/07/2026 OptimoRoute incident went unnoticed until residents
 * stopped getting notifications. Follows the nightly-sync-to-dm-ops row
 * convention (entity_type = EF slug, zero-uuid entity_id, outbound).
 *
 * Never throws: observability must not fail the run it is observing.
 *
 * Stale-run check for a daily cron (no row in the last 25h = the run died or
 * never fired):
 *   SELECT max(created_at) FROM sync_log
 *   WHERE entity_type = 'push-orders-to-optimoroute'
 *   HAVING max(created_at) < now() - interval '25 hours';
 */
export async function logSyncRun(
  supabase: SupabaseClient<Database>,
  entityType: string,
  status: 'success' | 'failed',
  payload: Json,
  errorMessage?: string,
): Promise<void> {
  try {
    const { error } = await supabase.from('sync_log').insert({
      entity_type: entityType,
      entity_id: RUN_LEVEL_ENTITY_ID,
      direction: 'outbound',
      status,
      error_message: errorMessage ?? null,
      payload,
    })
    if (error) console.error(`sync_log write failed for ${entityType}: ${error.message}`)
  } catch (err) {
    console.error(
      `sync_log write failed for ${entityType}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
