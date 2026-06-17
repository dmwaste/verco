import { describe, it, expect } from 'vitest'
import {
  recoveryRate,
  RECOVERY_TARGET_PCT,
  RECOVERY_LOW_N,
  type RecoveryNotice,
} from '@/lib/ncn/recovery-rate'

/**
 * Builds a `rebookedStatusById` Map from a plain record for terse fixtures.
 */
function statusMap(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries))
}

describe('recoveryRate', () => {
  describe('constants', () => {
    it('exports the internal recovery target (~95%)', () => {
      expect(RECOVERY_TARGET_PCT).toBe(95)
    })

    it('exports the low-n threshold (5)', () => {
      expect(RECOVERY_LOW_N).toBe(5)
    })
  })

  describe('empty', () => {
    it('zero notices → recoverable 0, recovered 0, rate null, isEmpty', () => {
      const result = recoveryRate([], new Map())
      expect(result).toEqual({
        recoverable: 0,
        recovered: 0,
        rate: null,
        isEmpty: true,
        isLowN: false,
      })
    })

    it('rate is null whenever recoverable is 0 (never divides by zero)', () => {
      expect(recoveryRate([], statusMap({})).rate).toBeNull()
    })
  })

  describe('low-n boundary (denominator < 5)', () => {
    it('1 notice (rescheduled + completed) → low-n, no colour-able %', () => {
      const notices: RecoveryNotice[] = [{ rescheduledBookingId: 'b1' }]
      const result = recoveryRate(notices, statusMap({ b1: 'Completed' }))
      expect(result.recoverable).toBe(1)
      expect(result.recovered).toBe(1)
      expect(result.rate).toBe(100)
      expect(result.isEmpty).toBe(false)
      expect(result.isLowN).toBe(true)
    })

    it('4 notices is still low-n (boundary just below 5)', () => {
      const notices: RecoveryNotice[] = [
        { rescheduledBookingId: 'b1' },
        { rescheduledBookingId: 'b2' },
        { rescheduledBookingId: 'b3' },
        { rescheduledBookingId: null },
      ]
      const result = recoveryRate(
        notices,
        statusMap({ b1: 'Completed', b2: 'Completed', b3: 'Completed' }),
      )
      expect(result.recoverable).toBe(4)
      expect(result.recovered).toBe(3)
      expect(result.isLowN).toBe(true)
      expect(result.isEmpty).toBe(false)
    })
  })

  describe('at-n boundary (denominator >= 5)', () => {
    it('5 notices is at-n (boundary exactly at threshold)', () => {
      const notices: RecoveryNotice[] = [
        { rescheduledBookingId: 'b1' },
        { rescheduledBookingId: 'b2' },
        { rescheduledBookingId: 'b3' },
        { rescheduledBookingId: 'b4' },
        { rescheduledBookingId: null },
      ]
      const result = recoveryRate(
        notices,
        statusMap({
          b1: 'Completed',
          b2: 'Completed',
          b3: 'Completed',
          b4: 'Completed',
        }),
      )
      expect(result.recoverable).toBe(5)
      expect(result.recovered).toBe(4)
      expect(result.rate).toBe(80)
      expect(result.isLowN).toBe(false)
      expect(result.isEmpty).toBe(false)
    })
  })

  describe('recovery classification', () => {
    it('rescheduled AND Completed → recovered', () => {
      const notices: RecoveryNotice[] = [{ rescheduledBookingId: 'b1' }]
      expect(recoveryRate(notices, statusMap({ b1: 'Completed' })).recovered).toBe(1)
    })

    it('rescheduled but rebooked booking is Submitted → NOT recovered', () => {
      const notices: RecoveryNotice[] = [{ rescheduledBookingId: 'b1' }]
      const result = recoveryRate(notices, statusMap({ b1: 'Submitted' }))
      expect(result.recovered).toBe(0)
      expect(result.recoverable).toBe(1)
    })

    it('rescheduled but rebooked booking is Cancelled → NOT recovered', () => {
      const notices: RecoveryNotice[] = [{ rescheduledBookingId: 'b1' }]
      const result = recoveryRate(notices, statusMap({ b1: 'Cancelled' }))
      expect(result.recovered).toBe(0)
      expect(result.recoverable).toBe(1)
    })

    it('rescheduled but rebooked booking is Scheduled (in-flight) → NOT recovered', () => {
      const notices: RecoveryNotice[] = [{ rescheduledBookingId: 'b1' }]
      const result = recoveryRate(notices, statusMap({ b1: 'Scheduled' }))
      expect(result.recovered).toBe(0)
      expect(result.recoverable).toBe(1)
    })

    it('null rescheduledBookingId (never rebooked) → NOT recovered, still counts in denominator', () => {
      const notices: RecoveryNotice[] = [{ rescheduledBookingId: null }]
      const result = recoveryRate(notices, new Map())
      expect(result.recovered).toBe(0)
      expect(result.recoverable).toBe(1)
    })

    it('refund-resolved notice (Resolved status, no rebook) → NOT recovered, in denominator', () => {
      // §8 #4: a refund-resolved notice has no rescheduled_booking_id → non-recovery.
      const notices: RecoveryNotice[] = [{ rescheduledBookingId: null }]
      const result = recoveryRate(notices, new Map())
      expect(result.recovered).toBe(0)
      expect(result.recoverable).toBe(1)
    })

    it('rescheduledBookingId set but missing from the status Map → NOT recovered', () => {
      // Defensive: a rebooked id with no corresponding fetched booking row.
      const notices: RecoveryNotice[] = [{ rescheduledBookingId: 'ghost' }]
      const result = recoveryRate(notices, new Map())
      expect(result.recovered).toBe(0)
      expect(result.recoverable).toBe(1)
    })
  })

  describe('mixed NCN + NP set (denominator is ALL in-scope, not pre-filtered)', () => {
    it('counts every notice in the denominator regardless of its own status', () => {
      // Caller stitches NCN and NP into one array (spec §3.5). The pure fn does
      // not know or care which is which — it only reads rescheduledBookingId.
      const notices: RecoveryNotice[] = [
        { rescheduledBookingId: 'rebook-1' }, // recovered
        { rescheduledBookingId: 'rebook-2' }, // rebooked but not completed
        { rescheduledBookingId: null }, // never rebooked
        { rescheduledBookingId: 'rebook-3' }, // recovered
        { rescheduledBookingId: null }, // never rebooked
        { rescheduledBookingId: 'rebook-4' }, // recovered
      ]
      const result = recoveryRate(
        notices,
        statusMap({
          'rebook-1': 'Completed',
          'rebook-2': 'Confirmed',
          'rebook-3': 'Completed',
          'rebook-4': 'Completed',
        }),
      )
      expect(result.recoverable).toBe(6)
      expect(result.recovered).toBe(3)
      expect(result.rate).toBe(50)
      expect(result.isLowN).toBe(false)
    })

    it('all recovered → 100%', () => {
      const notices: RecoveryNotice[] = [
        { rescheduledBookingId: 'b1' },
        { rescheduledBookingId: 'b2' },
        { rescheduledBookingId: 'b3' },
        { rescheduledBookingId: 'b4' },
        { rescheduledBookingId: 'b5' },
      ]
      const result = recoveryRate(
        notices,
        statusMap({
          b1: 'Completed',
          b2: 'Completed',
          b3: 'Completed',
          b4: 'Completed',
          b5: 'Completed',
        }),
      )
      expect(result.recovered).toBe(5)
      expect(result.recoverable).toBe(5)
      expect(result.rate).toBe(100)
    })

    it('none recovered → 0%', () => {
      const notices: RecoveryNotice[] = [
        { rescheduledBookingId: null },
        { rescheduledBookingId: 'b2' },
        { rescheduledBookingId: null },
        { rescheduledBookingId: 'b4' },
        { rescheduledBookingId: null },
      ]
      const result = recoveryRate(
        notices,
        statusMap({ b2: 'Cancelled', b4: 'Submitted' }),
      )
      expect(result.recovered).toBe(0)
      expect(result.recoverable).toBe(5)
      expect(result.rate).toBe(0)
    })
  })

  describe('rate value', () => {
    it('does not pre-round — 1 of 3 yields the exact fraction', () => {
      const notices: RecoveryNotice[] = [
        { rescheduledBookingId: 'b1' },
        { rescheduledBookingId: null },
        { rescheduledBookingId: null },
      ]
      const result = recoveryRate(notices, statusMap({ b1: 'Completed' }))
      expect(result.rate).toBeCloseTo(33.3333, 3)
    })
  })

  describe('invalid / defensive inputs', () => {
    it('a notice with undefined rescheduledBookingId is treated as not rebooked', () => {
      // Tolerate loosely-typed callers passing undefined for a nullable column.
      const notices = [
        { rescheduledBookingId: undefined },
      ] as unknown as RecoveryNotice[]
      const result = recoveryRate(notices, new Map())
      expect(result.recoverable).toBe(1)
      expect(result.recovered).toBe(0)
    })

    it('an empty-string rescheduledBookingId is not a valid rebook target', () => {
      const notices = [
        { rescheduledBookingId: '' },
      ] as unknown as RecoveryNotice[]
      const result = recoveryRate(notices, statusMap({ '': 'Completed' }))
      expect(result.recoverable).toBe(1)
      expect(result.recovered).toBe(0)
    })

    it('status comparison is case-sensitive — "completed" does not count', () => {
      const notices: RecoveryNotice[] = [{ rescheduledBookingId: 'b1' }]
      const result = recoveryRate(notices, statusMap({ b1: 'completed' }))
      expect(result.recovered).toBe(0)
    })
  })
})
