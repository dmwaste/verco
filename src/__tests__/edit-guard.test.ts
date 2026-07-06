import { describe, it, expect } from 'vitest'
import { evaluateEditGuard } from '@/lib/booking/edit-guard'

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
