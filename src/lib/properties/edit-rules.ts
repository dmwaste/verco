import { isContractorStaff } from '@/lib/auth/roles'

/**
 * Rules for editing an eligible property in place (#502 / BR-0034).
 *
 * Before this, the only way to correct a property was "mark ineligible +
 * create new" — which orphaned its bookings, allocation overrides and swaps on
 * the old row and handed the new row a fresh full FY allocation (real money).
 *
 * Decisions (Dan, 22/08/2026):
 *   - `address` is editable by every admin role; derived geocode columns are
 *     cleared and the row is re-geocoded automatically.
 *   - Moving `collection_area_id` is contractor-only (mirrors the #378
 *     date-override precedent) and BLOCKED while the property has any booking
 *     that is not yet terminal — those bookings' dates and capacity counters
 *     belong to the old area.
 */

/** Booking statuses that still hold a collection slot in the current area. */
export const NON_TERMINAL_BOOKING_STATUSES: readonly string[] = [
  'Pending Payment',
  'Submitted',
  'Confirmed',
  'Scheduled',
]

export type MoveAreaDecision =
  | { ok: true }
  | { ok: false; reason: 'contractor-only' | 'live-bookings'; liveCount?: number }

export function canMoveArea(
  role: string | null | undefined,
  bookingStatuses: readonly string[],
): MoveAreaDecision {
  if (!isContractorStaff(role)) return { ok: false, reason: 'contractor-only' }
  const live = bookingStatuses.filter((s) => NON_TERMINAL_BOOKING_STATUSES.includes(s)).length
  if (live > 0) return { ok: false, reason: 'live-bookings', liveCount: live }
  return { ok: true }
}

/** Normalise an address for the duplicate guard / storage: trim + collapse spaces. */
export function normaliseAddress(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}
