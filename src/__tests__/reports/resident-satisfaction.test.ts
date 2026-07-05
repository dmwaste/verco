import { describe, it, expect } from 'vitest'
import {
  computeResidentSatisfaction,
  RS_TARGET_PCT,
  RS_LOW_N,
  type ResidentSatisfactionRow,
  computeServicePreference,
} from '@/lib/reports/resident-satisfaction'

/**
 * Helper — wrap a raw `overall_rating` value in the row shape the caller hands
 * in (`{ responses: unknown }`, where `responses` is an opaque jsonb blob). Pass
 * a full object via `raw` to exercise malformed / missing-key inputs.
 */
function row(rating: unknown): ResidentSatisfactionRow {
  return { responses: { overall_rating: rating } }
}

function rawRow(responses: unknown): ResidentSatisfactionRow {
  return { responses }
}

// Each fold yields BOTH the WMRC KPI (good/pct, "% rated 4+") and the average
// (sum/avg). The Surveys page reads the former, the Reports page the latter.
describe('computeResidentSatisfaction', () => {
  describe('exported constants', () => {
    it('RS_TARGET_PCT is 75 (WMRC RS KPI, spec §3.10)', () => {
      expect(RS_TARGET_PCT).toBe(75)
    })
    it('RS_LOW_N is 5 (spec §3.10)', () => {
      expect(RS_LOW_N).toBe(5)
    })
  })

  describe('empty', () => {
    it('no rows → zeros, pct/avg null, isEmpty', () => {
      const result = computeResidentSatisfaction([])
      expect(result).toEqual({
        n: 0,
        good: 0,
        sum: 0,
        pct: null,
        avg: null,
        isEmpty: true,
        isLowN: false,
      })
    })

    it('rows present but all invalid → behaves as empty', () => {
      const result = computeResidentSatisfaction([
        row(null),
        row(NaN),
        row(0),
        row(6),
        row(3.5),
        rawRow(null),
        rawRow(undefined),
        rawRow('not an object'),
        rawRow({}),
      ])
      expect(result.n).toBe(0)
      expect(result.good).toBe(0)
      expect(result.sum).toBe(0)
      expect(result.pct).toBeNull()
      expect(result.avg).toBeNull()
      expect(result.isEmpty).toBe(true)
      expect(result.isLowN).toBe(false)
    })
  })

  describe('low-n (0 < n < RS_LOW_N)', () => {
    it('single good rating → pct 100, avg 5, isLowN', () => {
      const result = computeResidentSatisfaction([row(5)])
      expect(result.n).toBe(1)
      expect(result.good).toBe(1)
      expect(result.sum).toBe(5)
      expect(result.pct).toBe(100)
      expect(result.avg).toBe(5)
      expect(result.isEmpty).toBe(false)
      expect(result.isLowN).toBe(true)
    })

    it('4 ratings (just under LOW_N) → still low-n', () => {
      // 4,4,5,2 → 3 good of 4 → pct 75; sum 15 → avg 3.75
      const result = computeResidentSatisfaction([row(4), row(4), row(5), row(2)])
      expect(result.n).toBe(4)
      expect(result.good).toBe(3)
      expect(result.sum).toBe(15)
      expect(result.pct).toBe(75)
      expect(result.avg).toBeCloseTo(3.75, 5)
      expect(result.isEmpty).toBe(false)
      expect(result.isLowN).toBe(true)
    })
  })

  describe('at-n (n >= RS_LOW_N)', () => {
    it('exactly RS_LOW_N (5) valid ratings → not low-n', () => {
      // 4,4,5,5,1 → 4 good of 5 → pct 80; sum 19 → avg 3.8
      const result = computeResidentSatisfaction([
        row(4),
        row(4),
        row(5),
        row(5),
        row(1),
      ])
      expect(result.n).toBe(5)
      expect(result.good).toBe(4)
      expect(result.sum).toBe(19)
      expect(result.pct).toBe(80)
      expect(result.avg).toBeCloseTo(3.8, 5)
      expect(result.isEmpty).toBe(false)
      expect(result.isLowN).toBe(false)
    })

    it('all top marks → pct 100, avg 5', () => {
      const result = computeResidentSatisfaction([
        row(5),
        row(5),
        row(5),
        row(5),
        row(5),
        row(5),
      ])
      expect(result.n).toBe(6)
      expect(result.good).toBe(6)
      expect(result.sum).toBe(30)
      expect(result.pct).toBe(100)
      expect(result.avg).toBe(5)
      expect(result.isLowN).toBe(false)
    })

    it('mixed → fractional pct + avg preserved (not rounded)', () => {
      // 5,4,4,5,4,3,2,1 → 5 good of 8 → pct 62.5; sum 28 → avg 3.5
      const result = computeResidentSatisfaction([
        row(5),
        row(4),
        row(4),
        row(5),
        row(4),
        row(3),
        row(2),
        row(1),
      ])
      expect(result.n).toBe(8)
      expect(result.good).toBe(5)
      expect(result.sum).toBe(28)
      expect(result.pct).toBe(62.5)
      expect(result.avg).toBeCloseTo(3.5, 5)
      expect(result.isLowN).toBe(false)
    })

    it('none good → pct 0, avg 1', () => {
      const result = computeResidentSatisfaction([
        row(1),
        row(1),
        row(1),
        row(1),
        row(1),
      ])
      expect(result.n).toBe(5)
      expect(result.good).toBe(0)
      expect(result.sum).toBe(5)
      expect(result.pct).toBe(0)
      expect(result.avg).toBe(1)
      expect(result.isLowN).toBe(false)
    })
  })

  describe('rating boundary — good = rating >= 4', () => {
    it('rating 3 is NOT good; rating 4 IS good', () => {
      const result = computeResidentSatisfaction([row(3), row(4)])
      expect(result.n).toBe(2)
      expect(result.good).toBe(1)
      expect(result.sum).toBe(7)
      expect(result.avg).toBeCloseTo(3.5, 5)
    })

    it('ratings 1 and 2 are not good but still count toward sum', () => {
      const result = computeResidentSatisfaction([row(1), row(2)])
      expect(result.good).toBe(0)
      expect(result.sum).toBe(3)
    })

    it('rating 5 is good', () => {
      const result = computeResidentSatisfaction([row(5)])
      expect(result.good).toBe(1)
      expect(result.sum).toBe(5)
    })
  })

  describe('skips invalid ratings (counts only valid 1..5 integers)', () => {
    it('skips null and undefined', () => {
      const result = computeResidentSatisfaction([row(null), row(undefined), row(5)])
      expect(result.n).toBe(1)
      expect(result.good).toBe(1)
      expect(result.sum).toBe(5)
    })

    it('skips NaN', () => {
      const result = computeResidentSatisfaction([row(NaN), row(4)])
      expect(result.n).toBe(1)
      expect(result.good).toBe(1)
      expect(result.sum).toBe(4)
    })

    it('skips out-of-range (0 and 6)', () => {
      const result = computeResidentSatisfaction([row(0), row(6), row(4)])
      expect(result.n).toBe(1)
      expect(result.good).toBe(1)
      expect(result.sum).toBe(4)
    })

    it('skips non-integer ratings (3.5, 4.9)', () => {
      const result = computeResidentSatisfaction([row(3.5), row(4.9), row(4)])
      expect(result.n).toBe(1)
      expect(result.good).toBe(1)
      expect(result.sum).toBe(4)
    })

    it('skips non-numeric junk but keeps a coercible numeric string', () => {
      // Number('4') === 4 is a valid in-range integer and is kept; the rest are skipped.
      const result = computeResidentSatisfaction([
        row('hello'),
        row(true),
        row({}),
        row([]),
        row('4'),
      ])
      expect(result.n).toBe(1)
      expect(result.good).toBe(1)
      expect(result.sum).toBe(4)
    })

    it('folds valid ones while skipping interleaved invalid ones', () => {
      const result = computeResidentSatisfaction([
        row(5), // valid good
        row(null), // skip
        row(2), // valid bad
        row(6), // skip (out of range)
        row(4), // valid good
        row(3.5), // skip (non-integer)
        row(3), // valid bad
      ])
      expect(result.n).toBe(4)
      expect(result.good).toBe(2)
      expect(result.sum).toBe(14)
      expect(result.pct).toBe(50)
      expect(result.avg).toBeCloseTo(3.5, 5)
    })
  })

  describe('malformed responses blob', () => {
    it('responses missing entirely / wrong type → row skipped, no throw', () => {
      const result = computeResidentSatisfaction([
        rawRow(null),
        rawRow(undefined),
        rawRow(42),
        rawRow('string'),
        rawRow([1, 2, 3]),
        rawRow({ overall_rating: 5 }),
      ])
      expect(result.n).toBe(1)
      expect(result.good).toBe(1)
      expect(result.sum).toBe(5)
    })

    it('responses present but no overall_rating key → skipped', () => {
      const result = computeResidentSatisfaction([
        rawRow({ other_field: 5 }),
        rawRow({ overall_rating: 4 }),
      ])
      expect(result.n).toBe(1)
      expect(result.good).toBe(1)
      expect(result.sum).toBe(4)
    })
  })
})

// ── Service preference donut (design 02/07 batch 5) ─────────────────────────

describe('computeServicePreference', () => {
  it('counts Yes / No / Indifferent case- and space-insensitively', () => {
    const rows = [
      { responses: { prefer_service: 'Yes' } },
      { responses: { prefer_service: ' yes ' } },
      { responses: { prefer_service: 'No' } },
      { responses: { prefer_service: 'Indifferent' } },
    ]
    expect(computeServicePreference(rows)).toEqual({ yes: 2, no: 1, indifferent: 1, total: 4 })
  })

  it('skips unanswered, unrecognised and malformed blobs', () => {
    const rows = [
      { responses: { prefer_service: 'maybe' } },
      { responses: {} },
      { responses: null },
      { responses: 'junk' },
      { responses: { prefer_service: 3 } },
    ]
    expect(computeServicePreference(rows)).toEqual({ yes: 0, no: 0, indifferent: 0, total: 0 })
  })
})
