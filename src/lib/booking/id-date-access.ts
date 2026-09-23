/**
 * Which collection dates a role may book an illegal-dumping collection onto.
 *
 * Three tiers, and the capacity ceiling applies to all of them — a date with
 * `id_units_booked >= id_capacity_limit` is never bookable by anyone:
 *
 *   'any-open-or-closed' — contractor-admin. Any future date with ID capacity,
 *                          including admin-closed and public holidays (ops
 *                          override, migration 20260703040000).
 *   'locked-only'        — contractor-staff, client-admin, client-staff. An
 *                          otherwise-open date that the T-3 lock has closed.
 *                          WMRC asked for this before the 01/10 cutover so
 *                          council staff can place an ID collection inside the
 *                          3-day window while spots remain. A date closed for a
 *                          public holiday or by an admin stays closed, because
 *                          no crew runs that day.
 *   'open-only'          — ranger, and any other role. Open, unclosed dates.
 *
 * `id_is_closed` is `locked_closed OR full` (migration 20260518005937), so
 * "closed" alone never distinguishes locked from full. Callers must read
 * `locked_closed` and the raw counters, which is what `isIdDateBookable` does
 * and what the RPC's own gate mirrors.
 */
export type IdDateAccess = 'any-open-or-closed' | 'locked-only' | 'open-only'

export function idDateAccessForRole(role: string | null | undefined): IdDateAccess {
  if (role === 'contractor-admin') return 'any-open-or-closed'
  if (
    role === 'contractor-staff' ||
    role === 'client-admin' ||
    role === 'client-staff'
  ) {
    return 'locked-only'
  }
  return 'open-only'
}

/** The date's gate columns, from `collection_date` or `collection_date_pool`. */
export interface IdDateGate {
  is_open: boolean
  id_is_closed: boolean
  locked_closed: boolean
  id_capacity_limit: number
  id_units_booked: number
}

/**
 * Mirrors the closure + capacity gate in `create_id_booking_with_capacity_check`
 * so the picker never offers a date the RPC will reject (and never hides one it
 * would accept). Date-in-the-past is the caller's filter, not this one's.
 */
export function isIdDateBookable(gate: IdDateGate, access: IdDateAccess): boolean {
  const hasCapacity = gate.id_units_booked < gate.id_capacity_limit
  if (!hasCapacity) return false
  if (access === 'any-open-or-closed') return true
  if (!gate.is_open) return false
  if (access === 'locked-only') {
    // Closed purely by the T-3 lock is fine; closed for any other reason is not.
    // `id_is_closed` with capacity left and no lock means an admin closed it.
    return !gate.id_is_closed || gate.locked_closed
  }
  return !gate.id_is_closed
}
