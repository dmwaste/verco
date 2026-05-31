/**
 * Compound `(updated_at, id)` keyset cursor compare (pure).
 *
 * Orders rows by `updated_at` then `id` so same-timestamp rows are never skipped
 * (the spec's transport rule, §7). The EF advances the cursor to the last synced row
 * and selects `(updated_at, id) > cursor` for the next batch.
 */
import type { SyncCursor } from './types'

/**
 * Returns < 0 if a sorts before b, 0 if equal, > 0 if a sorts after b.
 *
 * `updated_at` is compared by absolute time (`Date.getTime()`), NOT lexicographically:
 * Postgres/PostgREST can serialize `timestamptz` with varying fractional-second precision
 * and a `Z` vs `+00:00` suffix, and text-sort disagrees with chronological order in those
 * cases (e.g. `...00Z` vs `...00.5Z` text-sorts wrong → a mis-ordered cursor silently SKIPS
 * a row). Numeric compare is serialization-independent (VER-239 §11c). The `id` tiebreak
 * stays lexicographic — uuid/text ids have a single canonical form.
 *
 * The EF still does the authoritative `(updated_at, id) > cursor` paging in SQL (index-backed,
 * time-correct); this helper derives/asserts the next cursor from an in-memory batch.
 */
export function compareCursor(a: SyncCursor, b: SyncCursor): number {
  const at = new Date(a.updated_at).getTime()
  const bt = new Date(b.updated_at).getTime()
  if (at < bt) return -1
  if (at > bt) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/** True when `row` is strictly after `cursor` — i.e. belongs in the next batch. */
export function isAfterCursor(row: SyncCursor, cursor: SyncCursor): boolean {
  return compareCursor(row, cursor) > 0
}
