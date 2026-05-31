/**
 * HubSpot batch-upsert request shaping + cursor-advance (pure).
 *
 * Extracted from the `sync-to-hubspot` Edge Function so the request body and the
 * cursor-advance rule are Vitest-testable (the EF orchestration over them is thin Deno
 * glue). Spec: docs/superpowers/specs/2026-05-29-verco-hubspot-sync-design.md §6/§7, §11c.
 */
import type { HubspotUpsertRecord, SyncCursor } from './types'
import { compareCursor } from './cursor'

/** Body for `POST /crm/v3/objects/{objectType}/batch/upsert`. */
export interface HubspotBatchUpsertBody {
  inputs: Array<{ idProperty: string; id: string; properties: Record<string, string> }>
}

/**
 * Shape mapper outputs into HubSpot's batch-upsert body.
 *
 * HubSpot requires every record in one batch/upsert call to share a single `idProperty`.
 * The EF calls this once per entity (Contacts by `email`, Orders by `hs_external_order_id`,
 * Tickets by `verco_ticket_id`), so the precondition holds by construction — asserted here
 * so a future caller that mixes entities fails loudly instead of silently mis-upserting.
 */
export function buildBatchUpsertBody(records: HubspotUpsertRecord[]): HubspotBatchUpsertBody {
  if (records.length > 0) {
    const idProperty = records[0]!.idProperty
    if (records.some((r) => r.idProperty !== idProperty)) {
      throw new Error('buildBatchUpsertBody: every record in a batch must share one idProperty')
    }
  }
  return {
    inputs: records.map((r) => ({ idProperty: r.idProperty, id: r.id, properties: r.properties })),
  }
}

/**
 * The cursor to persist after a synced batch: the maximum `(updated_at, id)` row.
 *
 * Returns null for an empty batch — the EF then leaves the stored cursor unchanged (no rows
 * to advance past). Computed as a defensive max via `compareCursor` so an unordered slice
 * still yields the true maximum; the EF only advances the cursor over rows it FULLY synced
 * (incl. associations), so a child whose parent isn't synced yet is excluded by the caller
 * and the cursor lags one tick (§3, §11c finding 5).
 */
export function maxCursor(rows: SyncCursor[]): SyncCursor | null {
  if (rows.length === 0) return null
  return rows.reduce((max, row) => (compareCursor(row, max) > 0 ? row : max))
}
