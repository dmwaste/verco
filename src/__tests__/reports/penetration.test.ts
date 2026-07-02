import { describe, it, expect } from 'vitest'
import {
  computePenetration,
  PENETRATION_LOW_N,
} from '@/lib/reports/penetration'

describe('PENETRATION — computePenetration (VER-179 §3.9)', () => {
  describe('constants', () => {
    it('exports PENETRATION_LOW_N = 25', () => {
      expect(PENETRATION_LOW_N).toBe(25)
    })
  })

  describe('empty — no eligible properties', () => {
    it('eligible = 0 → isEmpty, null pct, honest "no properties" display', () => {
      const r = computePenetration({ booked: 0, eligible: 0 })
      expect(r.isEmpty).toBe(true)
      expect(r.isLowN).toBe(false)
      expect(r.pct).toBeNull()
      expect(r.display).toBe('No eligible properties imported')
    })

    it('eligible = 0 even with a (nonsensical) positive booked count is still empty', () => {
      // Denominator drives emptiness; can't divide by zero.
      const r = computePenetration({ booked: 7, eligible: 0 })
      expect(r.isEmpty).toBe(true)
      expect(r.pct).toBeNull()
      expect(r.display).toBe('No eligible properties imported')
    })
  })

  describe('low-n — fewer than PENETRATION_LOW_N booked', () => {
    it('booked < 25 → isLowN, null pct (% headline suppressed), raw fraction display', () => {
      const r = computePenetration({ booked: 16, eligible: 107281 })
      expect(r.isEmpty).toBe(false)
      expect(r.isLowN).toBe(true)
      expect(r.pct).toBeNull()
      expect(r.display).toBe('16 / 107,281 properties booked')
    })

    it('booked = 1 (single booking) → low-n raw fraction, no %', () => {
      const r = computePenetration({ booked: 1, eligible: 500 })
      expect(r.isLowN).toBe(true)
      expect(r.pct).toBeNull()
      expect(r.display).toBe('1 / 500 properties booked')
    })

    it('booked = 0 but eligible > 0 → low-n (not empty), 0 / N display', () => {
      const r = computePenetration({ booked: 0, eligible: 1234 })
      expect(r.isEmpty).toBe(false)
      expect(r.isLowN).toBe(true)
      expect(r.pct).toBeNull()
      expect(r.display).toBe('0 / 1,234 properties booked')
    })

    it('thousands separators render in the fraction display', () => {
      const r = computePenetration({ booked: 12, eligible: 1000000 })
      expect(r.display).toBe('12 / 1,000,000 properties booked')
    })
  })

  describe('low-n boundary at PENETRATION_LOW_N', () => {
    it('booked = 24 (just below threshold) → low-n', () => {
      const r = computePenetration({ booked: 24, eligible: 1000 })
      expect(r.isLowN).toBe(true)
      expect(r.pct).toBeNull()
    })

    it('booked = 25 (exactly at threshold) → at-n, % computed', () => {
      const r = computePenetration({ booked: 25, eligible: 1000 })
      expect(r.isLowN).toBe(false)
      expect(r.isEmpty).toBe(false)
      expect(r.pct).toBe(2.5)
    })
  })

  describe('at-n — booked >= PENETRATION_LOW_N', () => {
    it('normal % computed: 100 * booked / eligible', () => {
      const r = computePenetration({ booked: 50, eligible: 200 })
      expect(r.isEmpty).toBe(false)
      expect(r.isLowN).toBe(false)
      expect(r.pct).toBe(25)
    })

    it('display at-n is a percentage string (per the contract)', () => {
      const r = computePenetration({ booked: 26, eligible: 107281 })
      // 100 * 26 / 107281 = 0.02423... %
      expect(r.pct).toBeCloseTo(0.024235, 5)
      expect(r.display).toBe('0.02%')
    })

    it('100% penetration when every eligible property is booked', () => {
      const r = computePenetration({ booked: 1000, eligible: 1000 })
      expect(r.pct).toBe(100)
      expect(r.display).toBe('100.00%')
    })
  })

  describe('lowNThreshold override (tunable)', () => {
    it('honours a custom threshold above the default', () => {
      const r = computePenetration({ booked: 30, eligible: 1000, lowNThreshold: 50 })
      expect(r.isLowN).toBe(true)
      expect(r.pct).toBeNull()
    })

    it('honours a custom threshold below the default', () => {
      const r = computePenetration({ booked: 10, eligible: 1000, lowNThreshold: 5 })
      expect(r.isLowN).toBe(false)
      expect(r.pct).toBe(1)
    })

    it('falls back to PENETRATION_LOW_N when lowNThreshold is undefined', () => {
      const r = computePenetration({ booked: 24, eligible: 1000, lowNThreshold: undefined })
      expect(r.isLowN).toBe(true)
    })
  })

  describe('invalid / defensive inputs', () => {
    it('negative eligible is treated as empty (no valid denominator)', () => {
      const r = computePenetration({ booked: 5, eligible: -10 })
      expect(r.isEmpty).toBe(true)
      expect(r.pct).toBeNull()
      expect(r.display).toBe('No eligible properties imported')
    })

    it('negative booked is clamped to 0', () => {
      const r = computePenetration({ booked: -5, eligible: 1000 })
      expect(r.isEmpty).toBe(false)
      expect(r.isLowN).toBe(true)
      expect(r.display).toBe('0 / 1,000 properties booked')
    })

    it('non-integer counts are floored before formatting', () => {
      const r = computePenetration({ booked: 16.9, eligible: 107281.4 })
      expect(r.isLowN).toBe(true)
      expect(r.display).toBe('16 / 107,281 properties booked')
    })

    it('NaN eligible is treated as empty', () => {
      const r = computePenetration({ booked: 5, eligible: NaN })
      expect(r.isEmpty).toBe(true)
      expect(r.pct).toBeNull()
    })

    it('Infinity eligible is treated as empty', () => {
      const r = computePenetration({ booked: 5, eligible: Infinity })
      expect(r.isEmpty).toBe(true)
      expect(r.pct).toBeNull()
    })

    it('NaN booked is clamped to 0', () => {
      const r = computePenetration({ booked: NaN, eligible: 1000 })
      expect(r.isLowN).toBe(true)
      expect(r.display).toBe('0 / 1,000 properties booked')
    })

    it('booked clamped to eligible cap never exceeds 100%', () => {
      // Defensive: a stray duplicate could push booked over eligible.
      const r = computePenetration({ booked: 1500, eligible: 1000 })
      expect(r.pct).toBe(100)
    })
  })
})
