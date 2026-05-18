/**
 * Resolves the authoritative capacity counters for a `collection_date` row,
 * given the area's `capacity_pool_id` membership.
 *
 * The capacity_pool architecture (migration 20260513080000_capacity_pool)
 * documents this invariant:
 *
 *   capacity_pool_id IS NULL     → use collection_date counters
 *   capacity_pool_id IS NOT NULL → use collection_date_pool counters;
 *                                  collection_date counters stay at 0
 *
 * Any UI rendering capacity numbers must consult both tables — surfaces that
 * read `collection_date.*` directly show zeros for pool-member areas (MCP:
 * Mosman, Cottesloe, Peppermint Grove, Fremantle North).
 *
 * Missing pool row for a date is treated as fully closed — matches what
 * `create_booking_with_capacity_check` does (RAISE EXCEPTION on missing pool
 * row), so the UI shouldn't surface a date the booking RPC would reject.
 */

export interface CollectionDateCapacity {
  date: string
  bulk_capacity_limit: number
  bulk_units_booked: number
  bulk_is_closed: boolean
  anc_capacity_limit: number
  anc_units_booked: number
  anc_is_closed: boolean
  id_capacity_limit: number
  id_units_booked: number
  id_is_closed: boolean
}

export type CollectionDatePoolCapacity = CollectionDateCapacity

export interface EffectiveCapacity {
  bulk_capacity_limit: number
  bulk_units_booked: number
  bulk_is_closed: boolean
  anc_capacity_limit: number
  anc_units_booked: number
  anc_is_closed: boolean
  id_capacity_limit: number
  id_units_booked: number
  id_is_closed: boolean
}

const ALL_CLOSED: EffectiveCapacity = {
  bulk_capacity_limit: 0,
  bulk_units_booked: 0,
  bulk_is_closed: true,
  anc_capacity_limit: 0,
  anc_units_booked: 0,
  anc_is_closed: true,
  id_capacity_limit: 0,
  id_units_booked: 0,
  id_is_closed: true,
}

export function indexPoolDates(
  rows: CollectionDatePoolCapacity[],
): Map<string, CollectionDatePoolCapacity> {
  return new Map(rows.map((r) => [r.date, r]))
}

export function effectiveCapacity(
  date: CollectionDateCapacity,
  poolId: string | null,
  poolByDate: Map<string, CollectionDatePoolCapacity>,
): EffectiveCapacity {
  if (!poolId) {
    return {
      bulk_capacity_limit: date.bulk_capacity_limit,
      bulk_units_booked: date.bulk_units_booked,
      bulk_is_closed: date.bulk_is_closed,
      anc_capacity_limit: date.anc_capacity_limit,
      anc_units_booked: date.anc_units_booked,
      anc_is_closed: date.anc_is_closed,
      id_capacity_limit: date.id_capacity_limit,
      id_units_booked: date.id_units_booked,
      id_is_closed: date.id_is_closed,
    }
  }
  const pool = poolByDate.get(date.date)
  if (!pool) return ALL_CLOSED
  return {
    bulk_capacity_limit: pool.bulk_capacity_limit,
    bulk_units_booked: pool.bulk_units_booked,
    bulk_is_closed: pool.bulk_is_closed,
    anc_capacity_limit: pool.anc_capacity_limit,
    anc_units_booked: pool.anc_units_booked,
    anc_is_closed: pool.anc_is_closed,
    id_capacity_limit: pool.id_capacity_limit,
    id_units_booked: pool.id_units_booked,
    id_is_closed: pool.id_is_closed,
  }
}
