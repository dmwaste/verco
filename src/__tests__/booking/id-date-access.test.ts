import { describe, it, expect } from 'vitest'
import {
  idDateAccessForRole,
  isIdDateBookable,
  type IdDateGate,
} from '@/lib/booking/id-date-access'

/** An open date with room. Spread + override to build each case. */
const base: IdDateGate = {
  is_open: true,
  id_is_closed: false,
  locked_closed: false,
  id_capacity_limit: 5,
  id_units_booked: 0,
}

/** Inside the 3-day window: the lock closed it, spots remain. */
const locked: IdDateGate = { ...base, id_is_closed: true, locked_closed: true }
/** Public holiday / admin-closed: no crew runs. */
const adminClosed: IdDateGate = { ...base, is_open: false }
/** Genuinely full. */
const full: IdDateGate = { ...base, id_units_booked: 5 }
/** Closed by an admin for ID specifically, not by the lock, room remaining. */
const idClosedNotLocked: IdDateGate = { ...base, id_is_closed: true }

describe('idDateAccessForRole', () => {
  it('gives contractor-admin the full override', () => {
    expect(idDateAccessForRole('contractor-admin')).toBe('any-open-or-closed')
  })

  it.each(['contractor-staff', 'client-admin', 'client-staff'])(
    'lets %s book a lock-closed date (WMRC 3-day ask)',
    (role) => {
      expect(idDateAccessForRole(role)).toBe('locked-only')
    },
  )

  it.each(['ranger', 'resident', null, undefined, 'nonsense'])(
    'leaves %s on open dates only',
    (role) => {
      expect(idDateAccessForRole(role)).toBe('open-only')
    },
  )
})

describe('isIdDateBookable', () => {
  it('never offers a full date, whatever the role', () => {
    expect(isIdDateBookable(full, 'any-open-or-closed')).toBe(false)
    expect(isIdDateBookable(full, 'locked-only')).toBe(false)
    expect(isIdDateBookable(full, 'open-only')).toBe(false)
    // Full AND locked — the lock must not smuggle a full date through.
    expect(
      isIdDateBookable({ ...full, id_is_closed: true, locked_closed: true }, 'locked-only'),
    ).toBe(false)
  })

  it('opens the 3-day window to council staff but not to rangers', () => {
    expect(isIdDateBookable(locked, 'locked-only')).toBe(true)
    expect(isIdDateBookable(locked, 'open-only')).toBe(false)
    expect(isIdDateBookable(locked, 'any-open-or-closed')).toBe(true)
  })

  it('keeps holidays and admin-closed dates shut for council staff', () => {
    expect(isIdDateBookable(adminClosed, 'locked-only')).toBe(false)
    expect(isIdDateBookable({ ...adminClosed, locked_closed: true }, 'locked-only')).toBe(false)
    // Contractor-admin keeps its existing ops override.
    expect(isIdDateBookable(adminClosed, 'any-open-or-closed')).toBe(true)
  })

  it('keeps an ID-closed-but-unlocked date shut for council staff', () => {
    expect(isIdDateBookable(idClosedNotLocked, 'locked-only')).toBe(false)
  })

  it('offers a plain open date to everyone', () => {
    expect(isIdDateBookable(base, 'open-only')).toBe(true)
    expect(isIdDateBookable(base, 'locked-only')).toBe(true)
    expect(isIdDateBookable(base, 'any-open-or-closed')).toBe(true)
  })
})
