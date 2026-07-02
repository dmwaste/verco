import { describe, it, expect } from 'vitest'
import {
  classifyBookingChannel,
  computeSelfServiceRate,
  N_MIN,
} from '@/lib/reports/self-service'

/**
 * SELFSVC — Self-Service Rate (VER-179 §3.6).
 *
 * Pure-function tests. No Supabase, no wall-clock — every input is a stored
 * row shape passed in. Covers all spec test cases (resident/admin/ranger/system,
 * low-n, NULL-legacy exclusion) plus empty / boundary / invalid inputs.
 */

// Convenience row builders.
const stamped = (created_via: string | null) => ({
  created_via,
  type: 'Residential' as const,
  status: 'Confirmed' as const,
})

describe('N_MIN constant', () => {
  it('is 20 (the SELFSVC low-n threshold)', () => {
    expect(N_MIN).toBe(20)
  })
})

describe('classifyBookingChannel', () => {
  it('classifies each known stamped value to itself', () => {
    expect(classifyBookingChannel({ created_via: 'resident' })).toBe('resident')
    expect(classifyBookingChannel({ created_via: 'admin' })).toBe('admin')
    expect(classifyBookingChannel({ created_via: 'ranger' })).toBe('ranger')
    expect(classifyBookingChannel({ created_via: 'system' })).toBe('system')
  })

  it('returns null for the legacy backfill marker', () => {
    expect(classifyBookingChannel({ created_via: 'legacy' })).toBeNull()
  })

  it('returns null for a NULL created_via (pre-CBSTAMP / untracked)', () => {
    expect(classifyBookingChannel({ created_via: null })).toBeNull()
  })

  it('returns null for undefined created_via (column absent in row)', () => {
    expect(classifyBookingChannel({})).toBeNull()
    expect(classifyBookingChannel({ created_via: undefined })).toBeNull()
  })

  it('returns null for an unknown / unexpected string value', () => {
    expect(classifyBookingChannel({ created_via: 'strata' })).toBeNull()
    expect(classifyBookingChannel({ created_via: '' })).toBeNull()
    expect(classifyBookingChannel({ created_via: 'RESIDENT' })).toBeNull()
  })

  it('returns null for a non-string created_via', () => {
    expect(
      classifyBookingChannel({ created_via: 1 as unknown as string }),
    ).toBeNull()
  })
})

describe('computeSelfServiceRate — empty', () => {
  it('no rows at all → empty (pct null)', () => {
    const r = computeSelfServiceRate([])
    expect(r).toEqual({
      inScope: 0,
      selfServed: 0,
      pct: null,
      excludedLegacy: 0,
      isEmpty: true,
      isLowN: false,
    })
  })

  it('rows exist but none are stamped (all legacy/null) → empty, with excludedLegacy', () => {
    const r = computeSelfServiceRate([
      stamped('legacy'),
      stamped(null),
      { created_via: 'legacy', type: 'MUD', status: 'Completed' },
    ])
    expect(r.inScope).toBe(0)
    expect(r.selfServed).toBe(0)
    expect(r.pct).toBeNull()
    expect(r.excludedLegacy).toBe(3)
    expect(r.isEmpty).toBe(true)
    expect(r.isLowN).toBe(false)
  })
})

describe('computeSelfServiceRate — in-scope filter', () => {
  it('excludes Cancelled bookings from scope entirely (num + denom + legacy)', () => {
    const r = computeSelfServiceRate([
      { created_via: 'resident', type: 'Residential', status: 'Cancelled' },
      { created_via: 'legacy', type: 'Residential', status: 'Cancelled' },
      stamped('resident'),
    ])
    // Only the one non-cancelled stamped resident row counts.
    expect(r.inScope).toBe(1)
    expect(r.selfServed).toBe(1)
    expect(r.excludedLegacy).toBe(0)
  })

  it('excludes non-Residential/MUD booking types from scope', () => {
    const r = computeSelfServiceRate([
      { created_via: 'ranger', type: 'Illegal Dumping', status: 'Confirmed' },
      { created_via: 'admin', type: 'Call Back - DM', status: 'Confirmed' },
      { created_via: 'system', type: 'Call Back - Client', status: 'Confirmed' },
      stamped('admin'),
    ])
    // Only the Residential admin row is in scope.
    expect(r.inScope).toBe(1)
    expect(r.selfServed).toBe(0)
  })

  it('includes MUD bookings in scope', () => {
    const r = computeSelfServiceRate([
      { created_via: 'resident', type: 'MUD', status: 'Confirmed' },
      { created_via: 'admin', type: 'MUD', status: 'Completed' },
    ])
    expect(r.inScope).toBe(2)
    expect(r.selfServed).toBe(1)
  })
})

describe('computeSelfServiceRate — denominator is stamped rows only', () => {
  it('legacy/null in-scope rows feed excludedLegacy, NOT the denominator', () => {
    const rows = [
      stamped('resident'),
      stamped('admin'),
      stamped('legacy'), // excluded from denom
      stamped(null), // excluded from denom
      { created_via: 'resident', type: 'MUD', status: 'Completed' },
    ]
    const r = computeSelfServiceRate(rows)
    expect(r.inScope).toBe(3) // resident + admin + MUD resident (stamped only)
    expect(r.selfServed).toBe(2) // two residents
    expect(r.excludedLegacy).toBe(2) // legacy + null
    expect(r.pct).toBeCloseTo((2 / 3) * 100)
  })

  it('an unknown stamped value is treated as legacy (excluded from denom)', () => {
    const r = computeSelfServiceRate([
      stamped('resident'),
      stamped('strata'), // unknown → excluded from denom, counted as legacy
    ])
    expect(r.inScope).toBe(1)
    expect(r.selfServed).toBe(1)
    expect(r.excludedLegacy).toBe(1)
  })

  it('Cancelled legacy rows do NOT inflate excludedLegacy (out of scope first)', () => {
    const r = computeSelfServiceRate([
      { created_via: 'legacy', type: 'Residential', status: 'Cancelled' },
      stamped('resident'),
    ])
    expect(r.excludedLegacy).toBe(0)
    expect(r.inScope).toBe(1)
  })
})

describe('computeSelfServiceRate — low-n boundary', () => {
  it('0 < stamped denom < N_MIN → low-n (raw fraction, no colour)', () => {
    const rows = Array.from({ length: 10 }, () => stamped('resident'))
    const r = computeSelfServiceRate(rows)
    expect(r.inScope).toBe(10)
    expect(r.selfServed).toBe(10)
    expect(r.isEmpty).toBe(false)
    expect(r.isLowN).toBe(true)
    expect(r.pct).toBe(100)
  })

  it('exactly N_MIN - 1 stamped rows is still low-n', () => {
    const rows = Array.from({ length: N_MIN - 1 }, () => stamped('resident'))
    const r = computeSelfServiceRate(rows)
    expect(r.inScope).toBe(N_MIN - 1)
    expect(r.isLowN).toBe(true)
    expect(r.isEmpty).toBe(false)
  })

  it('exactly N_MIN stamped rows crosses to at-n (not low-n)', () => {
    const rows = Array.from({ length: N_MIN }, () => stamped('resident'))
    const r = computeSelfServiceRate(rows)
    expect(r.inScope).toBe(N_MIN)
    expect(r.isLowN).toBe(false)
    expect(r.isEmpty).toBe(false)
    expect(r.pct).toBe(100)
  })

  it('legacy rows never push the stamped denom over the threshold', () => {
    // 19 stamped + 50 legacy → still low-n (denom is the 19 stamped only).
    const rows = [
      ...Array.from({ length: 19 }, () => stamped('resident')),
      ...Array.from({ length: 50 }, () => stamped('legacy')),
    ]
    const r = computeSelfServiceRate(rows)
    expect(r.inScope).toBe(19)
    expect(r.isLowN).toBe(true)
    expect(r.excludedLegacy).toBe(50)
  })
})

describe('computeSelfServiceRate — at-n percentage', () => {
  it('computes pct over the stamped denominator at/above N_MIN', () => {
    // 16 resident + 4 admin = 20 stamped (at-n) → 80%.
    const rows = [
      ...Array.from({ length: 16 }, () => stamped('resident')),
      ...Array.from({ length: 4 }, () => stamped('admin')),
    ]
    const r = computeSelfServiceRate(rows)
    expect(r.inScope).toBe(20)
    expect(r.selfServed).toBe(16)
    expect(r.pct).toBe(80)
    expect(r.isLowN).toBe(false)
    expect(r.isEmpty).toBe(false)
  })

  it('ranger + system stamped rows count in the denom but not the numerator', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => stamped('resident')),
      ...Array.from({ length: 5 }, () => stamped('ranger')),
      ...Array.from({ length: 5 }, () => stamped('system')),
    ]
    const r = computeSelfServiceRate(rows)
    expect(r.inScope).toBe(20)
    expect(r.selfServed).toBe(10)
    expect(r.pct).toBe(50)
  })
})

describe('computeSelfServiceRate — nMin override', () => {
  it('honours a custom nMin via options', () => {
    const rows = Array.from({ length: 6 }, () => stamped('resident'))
    expect(computeSelfServiceRate(rows, { nMin: 5 }).isLowN).toBe(false)
    expect(computeSelfServiceRate(rows, { nMin: 10 }).isLowN).toBe(true)
  })

  it('defaults nMin to N_MIN when options omitted', () => {
    const rows = Array.from({ length: 6 }, () => stamped('resident'))
    expect(computeSelfServiceRate(rows).isLowN).toBe(true)
  })
})

describe('computeSelfServiceRate — invalid / defensive inputs', () => {
  it('tolerates a missing created_via field (treats as legacy)', () => {
    const r = computeSelfServiceRate([
      { type: 'Residential', status: 'Confirmed' },
      stamped('resident'),
    ])
    expect(r.inScope).toBe(1)
    expect(r.excludedLegacy).toBe(1)
  })

  it('tolerates a null/undefined rows array → empty', () => {
    expect(computeSelfServiceRate(null as unknown as []).isEmpty).toBe(true)
    expect(computeSelfServiceRate(undefined as unknown as []).isEmpty).toBe(true)
  })

  it('rows with unknown status are still in scope when not Cancelled', () => {
    const r = computeSelfServiceRate([
      { created_via: 'resident', type: 'Residential', status: 'Scheduled' },
    ])
    expect(r.inScope).toBe(1)
  })
})
