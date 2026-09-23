import { describe, it, expect } from 'vitest'
import {
  idDateAccessForRole,
  isIdDateBookable,
  type IdDateGate,
} from '@/lib/booking/id-date-access'

/**
 * Fixed clock: Mon 28 Sep 2026, 09:00 AWST (01:00 UTC) — before the 3:00pm
 * cut-off for a Tue 29/09 collection, so the cases below stay about closure
 * and capacity unless they say otherwise.
 */
const NOW = new Date('2026-09-28T01:00:00Z')
const TOMORROW = '2026-09-29'

/** An open date with room. Spread + override to build each case. */
const base: IdDateGate = {
  date: TOMORROW,
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
    expect(isIdDateBookable(full, 'any-open-or-closed', NOW)).toBe(false)
    expect(isIdDateBookable(full, 'locked-only', NOW)).toBe(false)
    expect(isIdDateBookable(full, 'open-only', NOW)).toBe(false)
    // Full AND locked — the lock must not smuggle a full date through.
    expect(
      isIdDateBookable({ ...full, id_is_closed: true, locked_closed: true }, 'locked-only', NOW),
    ).toBe(false)
  })

  it('opens the 3-day window to council staff but not to rangers', () => {
    expect(isIdDateBookable(locked, 'locked-only', NOW)).toBe(true)
    expect(isIdDateBookable(locked, 'open-only', NOW)).toBe(false)
    expect(isIdDateBookable(locked, 'any-open-or-closed', NOW)).toBe(true)
  })

  it('keeps holidays and admin-closed dates shut for council staff', () => {
    expect(isIdDateBookable(adminClosed, 'locked-only', NOW)).toBe(false)
    expect(isIdDateBookable({ ...adminClosed, locked_closed: true }, 'locked-only', NOW)).toBe(false)
    // Contractor-admin keeps its existing ops override.
    expect(isIdDateBookable(adminClosed, 'any-open-or-closed', NOW)).toBe(true)
  })

  it('keeps an ID-closed-but-unlocked date shut for council staff', () => {
    expect(isIdDateBookable(idClosedNotLocked, 'locked-only', NOW)).toBe(false)
  })

  it('offers a plain open date to everyone', () => {
    expect(isIdDateBookable(base, 'open-only', NOW)).toBe(true)
    expect(isIdDateBookable(base, 'locked-only', NOW)).toBe(true)
    expect(isIdDateBookable(base, 'any-open-or-closed', NOW)).toBe(true)
  })
})

describe('the 3:00pm cut-off (WMRC) — binds every role', () => {
  const before = new Date('2026-09-28T06:59:00Z') // 2:59pm AWST
  const after = new Date('2026-09-28T07:01:00Z') // 3:01pm AWST

  it.each(['any-open-or-closed', 'locked-only', 'open-only'] as const)(
    'refuses a next-day booking after 3:00pm for %s',
    (access) => {
      expect(isIdDateBookable(base, access, before)).toBe(true)
      expect(isIdDateBookable(base, access, after)).toBe(false)
    },
  )

  it('leaves a later date alone — 9pm tonight is fine for Wednesday', () => {
    const wednesday: IdDateGate = { ...base, date: '2026-09-30' }
    const ninePm = new Date('2026-09-28T13:00:00Z')
    expect(isIdDateBookable(wednesday, 'locked-only', ninePm)).toBe(true)
  })

  it('still refuses a lock-closed next-day date for a ranger, before or after', () => {
    expect(isIdDateBookable(locked, 'open-only', before)).toBe(false)
    expect(isIdDateBookable(locked, 'open-only', after)).toBe(false)
  })
})
