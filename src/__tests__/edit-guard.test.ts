import { describe, it, expect } from 'vitest'
import { evaluateEditGuard, mayKeepClosedHeldDate } from '@/lib/booking/edit-guard'

// Collection date 2026-07-10 → cutoff is 2026-07-09 07:30:00 UTC (3:30pm AWST).
const DATE = '2026-07-10'
const BEFORE_CUTOFF = new Date(Date.UTC(2026, 6, 9, 7, 29, 0)) // 1 min before
const AFTER_CUTOFF = new Date(Date.UTC(2026, 6, 9, 7, 31, 0)) // 1 min after

describe('evaluateEditGuard — ownership (IDOR)', () => {
  it('rejects with 403 when the caller cannot see the booking (no row via RLS)', () => {
    const r = evaluateEditGuard({
      bookingExists: false,
      currentCollectionDate: DATE,
      role: 'resident',
      now: BEFORE_CUTOFF,
    })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ status: 403 })
  })

  it('allows a resident who owns the booking and is before cutoff', () => {
    const r = evaluateEditGuard({
      bookingExists: true,
      currentCollectionDate: DATE,
      role: 'resident',
      now: BEFORE_CUTOFF,
    })
    expect(r.ok).toBe(true)
  })
})

describe('evaluateEditGuard — cancellation cutoff', () => {
  it('rejects a resident editing after the cutoff', () => {
    const r = evaluateEditGuard({
      bookingExists: true,
      currentCollectionDate: DATE,
      role: 'resident',
      now: AFTER_CUTOFF,
    })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ status: 403 })
  })

  it('rejects an unauthenticated/anon caller (null role) after cutoff too', () => {
    const r = evaluateEditGuard({
      bookingExists: true,
      currentCollectionDate: DATE,
      role: null,
      now: AFTER_CUTOFF,
    })
    expect(r.ok).toBe(false)
  })

  it('exempts staff — a contractor may edit after the cutoff', () => {
    for (const role of ['contractor-admin', 'contractor-staff', 'client-admin', 'client-staff']) {
      const r = evaluateEditGuard({
        bookingExists: true,
        currentCollectionDate: DATE,
        role,
        now: AFTER_CUTOFF,
      })
      expect(r.ok, `${role} should be exempt`).toBe(true)
    }
  })

  it('allows when the current collection date is unknown (nothing to enforce against)', () => {
    const r = evaluateEditGuard({
      bookingExists: true,
      currentCollectionDate: null,
      role: 'resident',
      now: AFTER_CUTOFF,
    })
    expect(r.ok).toBe(true)
  })
})

describe('evaluateEditGuard — edit-role allowlist (SELECT ≠ EDIT)', () => {
  it('rejects field/ranger even though RLS lets them SELECT the booking', () => {
    for (const role of ['field', 'ranger']) {
      const r = evaluateEditGuard({
        bookingExists: true,
        currentCollectionDate: DATE,
        role,
        now: BEFORE_CUTOFF,
      })
      expect(r.ok, `${role} must not be allowed to edit`).toBe(false)
      expect(r).toMatchObject({ status: 403 })
    }
  })

  it('rejects a booking-visible caller with no role', () => {
    const r = evaluateEditGuard({
      bookingExists: true,
      currentCollectionDate: DATE,
      role: null,
      now: BEFORE_CUTOFF,
    })
    expect(r.ok).toBe(false)
  })

  it('allows residents and strata to edit their own booking', () => {
    for (const role of ['resident', 'strata']) {
      const r = evaluateEditGuard({
        bookingExists: true,
        currentCollectionDate: DATE,
        role,
        now: BEFORE_CUTOFF,
      })
      expect(r.ok, `${role} should be allowed`).toBe(true)
    }
  })
})

describe('mayKeepClosedHeldDate — waive the create-booking is_open guard (#378)', () => {
  const TARGET = 'date-held'

  it('lets a contractor keep the replaced booking\'s own held date', () => {
    for (const role of ['contractor-admin', 'contractor-staff']) {
      expect(
        mayKeepClosedHeldDate({
          role,
          replaces: 'booking-1',
          targetDateId: TARGET,
          heldDateIds: [TARGET, TARGET],
        }),
      ).toBe(true)
    }
  })

  it('blocks client-tier and residents even keeping the held date', () => {
    for (const role of ['client-admin', 'client-staff', 'resident', 'strata', 'field', 'ranger', null]) {
      expect(
        mayKeepClosedHeldDate({
          role,
          replaces: 'booking-1',
          targetDateId: TARGET,
          heldDateIds: [TARGET],
        }),
      ).toBe(false)
    }
  })

  it('blocks when not an edit (no replaces) — a new booking cannot land on a closed date', () => {
    expect(
      mayKeepClosedHeldDate({
        role: 'contractor-admin',
        replaces: null,
        targetDateId: TARGET,
        heldDateIds: [TARGET],
      }),
    ).toBe(false)
  })

  it('blocks MOVING to a closed date that is not the booking\'s held date', () => {
    expect(
      mayKeepClosedHeldDate({
        role: 'contractor-admin',
        replaces: 'booking-1',
        targetDateId: 'date-other-closed',
        heldDateIds: [TARGET],
      }),
    ).toBe(false)
  })

  it('blocks when the booking has no items / could not be read (empty held set)', () => {
    expect(
      mayKeepClosedHeldDate({
        role: 'contractor-admin',
        replaces: 'booking-1',
        targetDateId: TARGET,
        heldDateIds: [],
      }),
    ).toBe(false)
  })

  it('requires ALL items to share the held date (mixed → block)', () => {
    expect(
      mayKeepClosedHeldDate({
        role: 'contractor-admin',
        replaces: 'booking-1',
        targetDateId: TARGET,
        heldDateIds: [TARGET, 'date-other'],
      }),
    ).toBe(false)
  })
})
