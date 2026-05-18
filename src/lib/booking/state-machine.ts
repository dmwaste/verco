/**
 * Booking state machine — mirrors the SQL trigger enforce_booking_state_transition()
 * defined in 20260326053510_initial_schema.sql (lines 704-731).
 *
 * Keep this in sync with the DB trigger. The trigger is the enforcement layer;
 * this module enables client-side checks and testability.
 */

export const BOOKING_STATUSES = [
  'Pending Payment',
  'Submitted',
  'Confirmed',
  'Scheduled',
  'Completed',
  'Non-conformance',
  'Nothing Presented',
  'Rebooked',
  'Rescheduled',
  'Cancelled',
] as const

export type BookingStatus = (typeof BOOKING_STATUSES)[number]

const VALID_TRANSITIONS: ReadonlyMap<BookingStatus, readonly BookingStatus[]> = new Map([
  // Pending Payment → Confirmed is the auto-confirm path (Stripe webhook on
  // payment success). Pending Payment → Submitted is preserved as a safety
  // net but no production code path writes it.
  ['Pending Payment', ['Submitted', 'Confirmed', 'Cancelled']],
  ['Submitted', ['Confirmed', 'Cancelled']],
  ['Confirmed', ['Scheduled', 'Cancelled']],
  ['Scheduled', ['Completed', 'Non-conformance', 'Nothing Presented', 'Cancelled']],
  ['Non-conformance', ['Rebooked']],
  ['Nothing Presented', ['Rebooked']],
])

/** Returns true if the transition from → to is valid per the state machine. */
export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return VALID_TRANSITIONS.get(from)?.includes(to) ?? false
}

/** Returns the list of valid target statuses from the given status, or empty array for terminal states. */
export function getValidTargets(from: BookingStatus): readonly BookingStatus[] {
  return VALID_TRANSITIONS.get(from) ?? []
}
