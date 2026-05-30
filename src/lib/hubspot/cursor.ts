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
 * Lexicographic compare is correct for ISO-8601 timestamps and for uuid/text ids.
 */
export function compareCursor(a: SyncCursor, b: SyncCursor): number {
  if (a.updated_at < b.updated_at) return -1
  if (a.updated_at > b.updated_at) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/** True when `row` is strictly after `cursor` — i.e. belongs in the next batch. */
export function isAfterCursor(row: SyncCursor, cursor: SyncCursor): boolean {
  return compareCursor(row, cursor) > 0
}
