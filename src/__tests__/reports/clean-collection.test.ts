import { describe, it, expect } from 'vitest'
import {
  computeCleanCollection,
  CLEAN_TARGET_PCT,
  CLEAN_LOW_N,
} from '@/lib/reports/clean-collection'

/**
 * BC — Clean Collection Rate (VER-179 §3.1).
 *
 * rate = (eligible − miss) / eligible × 100, where `miss` is the count of
 * contractor-fault NCN booking ids INTERSECTED with the eligible set (a raw
 * NCN count is never trusted — an NCN can point at a booking outside the
 * FY/area-scoped eligible set the caller assembled).
 *
 * Render states: empty (eligible = 0) · low-n (0 < eligible < 20) · at-n (≥ 20).
 */

// Helper: build an eligible set of N synthetic booking ids `b1..bN`.
const eligibleSet = (n: number) =>
  new Set(Array.from({ length: n }, (_, i) => `b${i + 1}`))

describe('clean-collection — constants', () => {
  it('CLEAN_TARGET_PCT is the WMRC contractual 98%', () => {
    expect(CLEAN_TARGET_PCT).toBe(98)
  })

  it('CLEAN_LOW_N is 20', () => {
    expect(CLEAN_LOW_N).toBe(20)
  })
})

describe('clean-collection — empty', () => {
  it('eligible = 0 → empty, pct null, miss 0', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: new Set<string>(),
      contractorFaultNcnBookingIds: new Set<string>(),
    })
    expect(r.eligible).toBe(0)
    expect(r.miss).toBe(0)
    expect(r.pct).toBeNull()
    expect(r.isEmpty).toBe(true)
    expect(r.isLowN).toBe(false)
  })

  it('eligible = 0 even with NCN ids present (no eligible bookings) → empty, miss 0', () => {
    // NCNs that intersect nothing because there are no eligible bookings at all.
    const r = computeCleanCollection({
      eligibleBookingIds: new Set<string>(),
      contractorFaultNcnBookingIds: new Set(['x1', 'x2']),
    })
    expect(r.eligible).toBe(0)
    expect(r.miss).toBe(0)
    expect(r.pct).toBeNull()
    expect(r.isEmpty).toBe(true)
  })
})

describe('clean-collection — low-n (0 < eligible < 20)', () => {
  it('eligible just below threshold (19) → low-n, no colour state, pct still computed', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: eligibleSet(19),
      contractorFaultNcnBookingIds: new Set(['b1']),
    })
    expect(r.eligible).toBe(19)
    expect(r.miss).toBe(1)
    expect(r.isEmpty).toBe(false)
    expect(r.isLowN).toBe(true)
    // pct is still a number in low-n (denominator shown raw in UI), not coloured.
    expect(r.pct).toBeCloseTo((18 / 19) * 100, 6)
  })

  it('eligible = 1 with that one booking missed → 0%, low-n', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: new Set(['only']),
      contractorFaultNcnBookingIds: new Set(['only']),
    })
    expect(r.eligible).toBe(1)
    expect(r.miss).toBe(1)
    expect(r.pct).toBe(0)
    expect(r.isLowN).toBe(true)
    expect(r.isEmpty).toBe(false)
  })

  it('eligible = 1 clean → 100%, low-n', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: new Set(['only']),
      contractorFaultNcnBookingIds: new Set<string>(),
    })
    expect(r.eligible).toBe(1)
    expect(r.miss).toBe(0)
    expect(r.pct).toBe(100)
    expect(r.isLowN).toBe(true)
  })
})

describe('clean-collection — at-n (eligible ≥ 20)', () => {
  it('exactly at threshold (20) flips out of low-n', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: eligibleSet(20),
      contractorFaultNcnBookingIds: new Set<string>(),
    })
    expect(r.eligible).toBe(20)
    expect(r.isLowN).toBe(false)
    expect(r.isEmpty).toBe(false)
    expect(r.pct).toBe(100)
  })

  it('≥ 98% (pass-band) — 1 miss in 100', () => {
    const elig = eligibleSet(100)
    const r = computeCleanCollection({
      eligibleBookingIds: elig,
      contractorFaultNcnBookingIds: new Set(['b1']),
    })
    expect(r.eligible).toBe(100)
    expect(r.miss).toBe(1)
    expect(r.pct).toBe(99)
    expect(r.pct! >= CLEAN_TARGET_PCT).toBe(true)
    expect(r.isLowN).toBe(false)
  })

  it('below 98% (below-target band) — 3 misses in 50 = 94%', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: eligibleSet(50),
      contractorFaultNcnBookingIds: new Set(['b1', 'b2', 'b3']),
    })
    expect(r.eligible).toBe(50)
    expect(r.miss).toBe(3)
    expect(r.pct).toBe(94)
    expect(r.pct! < CLEAN_TARGET_PCT).toBe(true)
  })

  it('exactly on target — 98% (1 miss in 50)', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: eligibleSet(50),
      contractorFaultNcnBookingIds: new Set(['b1']),
    })
    expect(r.pct).toBe(98)
    expect(r.pct! >= CLEAN_TARGET_PCT).toBe(true)
  })
})

describe('clean-collection — intersection (never trust a raw NCN count)', () => {
  it('NCN ids OUTSIDE the eligible set are intersected out (not counted as a miss)', () => {
    // 30 eligible bookings, but the NCN set names ids that are NOT eligible
    // (e.g. an NCN against a booking in a different FY or area).
    const r = computeCleanCollection({
      eligibleBookingIds: eligibleSet(30),
      contractorFaultNcnBookingIds: new Set(['out1', 'out2', 'out3']),
    })
    expect(r.eligible).toBe(30)
    expect(r.miss).toBe(0) // none of out1..3 are in the eligible set
    expect(r.pct).toBe(100)
  })

  it('mixed: some NCN ids in the eligible set, some outside → only the inside ones count', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: eligibleSet(40), // b1..b40
      contractorFaultNcnBookingIds: new Set(['b1', 'b2', 'outsider', 'another-outsider']),
    })
    expect(r.eligible).toBe(40)
    expect(r.miss).toBe(2) // only b1, b2 intersect
    expect(r.pct).toBe(95)
  })

  it('duplicate NCN ids in the Set cannot double-count (Set membership is idempotent)', () => {
    // A Set inherently dedupes; this guards the intersection logic against
    // ever counting a booking twice.
    const ncn = new Set(['b5'])
    const r = computeCleanCollection({
      eligibleBookingIds: eligibleSet(25),
      contractorFaultNcnBookingIds: ncn,
    })
    expect(r.miss).toBe(1)
    expect(r.eligible).toBe(25)
  })

  it('all eligible bookings missed → 0%', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: eligibleSet(25),
      contractorFaultNcnBookingIds: eligibleSet(25),
    })
    expect(r.eligible).toBe(25)
    expect(r.miss).toBe(25)
    expect(r.pct).toBe(0)
  })
})

describe('clean-collection — null / invalid inputs (defensive)', () => {
  it('null inputs are treated as empty sets → empty result', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: null as unknown as Set<string>,
      contractorFaultNcnBookingIds: null as unknown as Set<string>,
    })
    expect(r.eligible).toBe(0)
    expect(r.miss).toBe(0)
    expect(r.pct).toBeNull()
    expect(r.isEmpty).toBe(true)
  })

  it('undefined inputs are treated as empty sets → empty result', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: undefined as unknown as Set<string>,
      contractorFaultNcnBookingIds: undefined as unknown as Set<string>,
    })
    expect(r.eligible).toBe(0)
    expect(r.miss).toBe(0)
    expect(r.pct).toBeNull()
    expect(r.isEmpty).toBe(true)
  })

  it('null NCN set with a valid eligible set → no misses', () => {
    const r = computeCleanCollection({
      eligibleBookingIds: eligibleSet(20),
      contractorFaultNcnBookingIds: null as unknown as Set<string>,
    })
    expect(r.eligible).toBe(20)
    expect(r.miss).toBe(0)
    expect(r.pct).toBe(100)
  })

  it('miss can never exceed eligible (pct never negative)', () => {
    // Even if the caller passes more NCN ids than eligible, intersection caps
    // miss at the eligible count.
    const r = computeCleanCollection({
      eligibleBookingIds: eligibleSet(20),
      contractorFaultNcnBookingIds: eligibleSet(50), // superset b1..b50
    })
    expect(r.miss).toBe(20)
    expect(r.pct).toBe(0)
    expect(r.pct! >= 0).toBe(true)
  })
})
