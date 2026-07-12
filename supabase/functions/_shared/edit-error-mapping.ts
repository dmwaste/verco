/**
 * Shared error taxonomy for the inline admin quantity edit (`create-booking`
 * EF's `replaces` branch → `update_booking_items_in_place` RPC).
 *
 * `CONCURRENT_EDIT_MARKER` is the single source of truth for the substring the
 * RPC's concurrency-guard RAISE messages must contain. Migration
 * `20260712000000_update_booking_items_expected_items_guard.sql` RAISEs it from
 * THREE sites (status changed / items changed / date changed, #387.1) so a
 * concurrent edit surfaces as one retryable conflict. If that literal ever
 * changes on either side, both must move together — hence one constant here.
 * Note the RPC side is an ALREADY-APPLIED migration: change its RAISE wording via
 * a NEW migration (CREATE OR REPLACE), never by editing the applied file — a
 * `db push` matches by version and silently skips an edited applied migration,
 * so prod would keep the old wording and the marker would drift.
 *
 * `mapEditErrorToStatus` turns the RPC's Postgres error message into the HTTP
 * status (+ optional response code) the EF returns. Kept pure + deterministic so
 * the mapping is unit-testable without spinning up the RPC. Capacity shortfalls
 * (`Insufficient …`) keep their own 409 branch in the EF — they predate this
 * taxonomy and are not an "edit error → status" case, so they are handled before
 * this mapping runs.
 *
 * Mirror of src/lib/booking/edit-error-mapping.ts (kept in sync by
 * scripts/sync-mirrors.sh — _shared is the source of truth).
 */

/** Substring every concurrent-edit RAISE message in the RPC contains. */
export const CONCURRENT_EDIT_MARKER = 'changed since this edit was priced'

/** HTTP mapping for an edit RPC error. `code` is set only for concurrent edits. */
export interface EditErrorMapping {
  status: number
  code?: 'concurrent_edit'
}

/**
 * Map an `update_booking_items_in_place` error message to an HTTP response.
 *
 * - `not found` (booking row vanished under the lock) → 404
 * - {@link CONCURRENT_EDIT_MARKER} (a concurrent status/items/date change since
 *   this edit was priced) → 409 with `code: 'concurrent_edit'` so the client can
 *   reload and re-price rather than treat it as a hard failure
 * - anything else → 500 (unexpected — the caller wraps the message)
 */
export function mapEditErrorToStatus(message: string): EditErrorMapping {
  if (message.includes('not found')) return { status: 404 }
  if (message.includes(CONCURRENT_EDIT_MARKER)) {
    return { status: 409, code: 'concurrent_edit' }
  }
  return { status: 500 }
}
