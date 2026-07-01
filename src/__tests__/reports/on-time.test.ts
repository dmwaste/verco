import { describe, it, expect } from 'vitest'
import {
  computeOnTime,
  isOnTime,
  ON_TIME_TARGET_PCT,
  ON_TIME_LOW_N,
  type OnTimeStop,
} from '@/lib/reports/on-time'

/**
 * ONTIME (spec §3.2): a completed stop is on-time when the AWST calendar date of
 * its `completed_at` (UTC instant) equals its scheduled `collection_date.date`
 * (already an AWST YYYY-MM-DD). The comparison MUST go through `awstDateFromUtc`
 * — comparing the raw UTC date mis-buckets early-morning AWST closeouts.
 *
 * AWST is UTC+8 year-round (no DST). Calendar anchors used below:
 *   2026-06-16T05:00:00Z  = 2026-06-16T13:00 AWST → AWST date 06-16
 *   2026-06-16T23:30:00Z  = 2026-06-17T07:30 AWST → AWST date 06-17 (NOT 06-16)
 *   2026-06-17T15:00:00Z  = 2026-06-17T23:00 AWST → AWST date 06-17
 */

const stop = (completed_at: string, scheduledDate: string): OnTimeStop => ({
  completed_at,
  scheduledDate,
})

describe('ON_TIME_TARGET_PCT / ON_TIME_LOW_N', () => {
  it('targets the WMRC contractual 98%', () => {
    expect(ON_TIME_TARGET_PCT).toBe(98)
  })

  it('uses a per-stop low-n threshold of 20', () => {
    expect(ON_TIME_LOW_N).toBe(20)
  })
})

describe('isOnTime', () => {
  it('is true when the AWST completion date equals the scheduled date', () => {
    // 13:00 AWST on 06-16, scheduled 06-16 → on-time.
    expect(isOnTime(stop('2026-06-16T05:00:00Z', '2026-06-16'))).toBe(true)
  })

  it('is false when the collection ran one day late', () => {
    // 23:00 AWST on 06-17, scheduled 06-16 → one day late.
    expect(isOnTime(stop('2026-06-17T15:00:00Z', '2026-06-16'))).toBe(false)
  })

  it('is true at the very end of the AWST scheduled day (23:00 AWST)', () => {
    // 2026-06-17T15:00Z = 23:00 AWST 06-17, scheduled 06-17 → still on-time.
    expect(isOnTime(stop('2026-06-17T15:00:00Z', '2026-06-17'))).toBe(true)
  })

  it('CRITICAL boundary: 23:30 UTC rolls into the NEXT AWST day', () => {
    // 2026-06-16T23:30Z = 2026-06-17T07:30 AWST → AWST date 06-17.
    // A stop scheduled for 06-17 and closed out at 7:30am AWST is ON-TIME.
    // A naive completed_at::date in UTC would read 06-16 and mark it EARLY/wrong.
    expect(isOnTime(stop('2026-06-16T23:30:00Z', '2026-06-17'))).toBe(true)
  })

  it('CRITICAL boundary: 23:30 UTC is NOT the same as the prior UTC AWST day', () => {
    // Same instant 2026-06-16T23:30Z (AWST 06-17) but scheduled 06-16 → late,
    // proving the comparison uses the AWST date (06-17), not the UTC date (06-16).
    expect(isOnTime(stop('2026-06-16T23:30:00Z', '2026-06-16'))).toBe(false)
  })

  it('handles the midnight-AWST boundary (16:00 UTC = 00:00 AWST next day)', () => {
    // 2026-06-16T16:00Z = 2026-06-17T00:00 AWST → AWST date 06-17.
    expect(isOnTime(stop('2026-06-16T16:00:00Z', '2026-06-17'))).toBe(true)
    expect(isOnTime(stop('2026-06-16T16:00:00Z', '2026-06-16'))).toBe(false)
  })
})

describe('computeOnTime', () => {
  it('returns the empty state when there are no completed stops', () => {
    expect(computeOnTime([])).toEqual({
      completed: 0,
      onTime: 0,
      pct: null,
      isEmpty: true,
      isLowN: false,
    })
  })

  it('low-n: 1 completed stop has a raw fraction but no pct headline', () => {
    const result = computeOnTime([stop('2026-06-16T05:00:00Z', '2026-06-16')])
    expect(result.completed).toBe(1)
    expect(result.onTime).toBe(1)
    expect(result.pct).toBeNull()
    expect(result.isEmpty).toBe(false)
    expect(result.isLowN).toBe(true)
  })

  it('low-n boundary: 19 completed stops is still low-n (pct null)', () => {
    const stops = Array.from({ length: 19 }, () =>
      stop('2026-06-16T05:00:00Z', '2026-06-16'),
    )
    const result = computeOnTime(stops)
    expect(result.completed).toBe(19)
    expect(result.isLowN).toBe(true)
    expect(result.pct).toBeNull()
  })

  it('at-n boundary: exactly 20 completed stops yields a pct (not low-n)', () => {
    const stops = Array.from({ length: 20 }, () =>
      stop('2026-06-16T05:00:00Z', '2026-06-16'),
    )
    const result = computeOnTime(stops)
    expect(result.completed).toBe(20)
    expect(result.onTime).toBe(20)
    expect(result.isLowN).toBe(false)
    expect(result.isEmpty).toBe(false)
    expect(result.pct).toBe(100)
  })

  it('all on-time at-n → 100%', () => {
    const stops = Array.from({ length: 25 }, () =>
      stop('2026-06-16T05:00:00Z', '2026-06-16'),
    )
    expect(computeOnTime(stops).pct).toBe(100)
  })

  it('computes a mixed pct over an at-n sample (24 of 25 on-time = 96)', () => {
    const onTimeStops = Array.from({ length: 24 }, () =>
      stop('2026-06-16T05:00:00Z', '2026-06-16'),
    )
    const lateStop = stop('2026-06-17T15:00:00Z', '2026-06-16')
    const result = computeOnTime([...onTimeStops, lateStop])
    expect(result.completed).toBe(25)
    expect(result.onTime).toBe(24)
    expect(result.pct).toBe(96)
  })

  it('counts the 23:30-UTC stop as on-time across an at-n sample (AWST proof)', () => {
    // 19 plainly-on-time stops + 1 boundary stop (23:30Z scheduled for the next
    // AWST day) = 20 completed, all on-time → 100%. A UTC-date comparison would
    // have marked the boundary stop wrong and dropped the pct to 95.
    const plain = Array.from({ length: 19 }, () =>
      stop('2026-06-16T05:00:00Z', '2026-06-16'),
    )
    const boundary = stop('2026-06-16T23:30:00Z', '2026-06-17')
    const result = computeOnTime([...plain, boundary])
    expect(result.completed).toBe(20)
    expect(result.onTime).toBe(20)
    expect(result.pct).toBe(100)
  })

  it('rounds the pct to one decimal place', () => {
    // 20 of 21 on-time = 95.238...% → 95.2
    const onTimeStops = Array.from({ length: 20 }, () =>
      stop('2026-06-16T05:00:00Z', '2026-06-16'),
    )
    const late = stop('2026-06-17T15:00:00Z', '2026-06-16')
    const result = computeOnTime([...onTimeStops, late])
    expect(result.completed).toBe(21)
    expect(result.onTime).toBe(20)
    expect(result.pct).toBe(95.2)
  })

  it('ignores stops with a null/invalid completed_at (defensive)', () => {
    const stops: OnTimeStop[] = [
      stop('2026-06-16T05:00:00Z', '2026-06-16'),
      { completed_at: null as unknown as string, scheduledDate: '2026-06-16' },
      { completed_at: 'not-a-date', scheduledDate: '2026-06-16' },
      { completed_at: '2026-06-16T05:00:00Z', scheduledDate: null as unknown as string },
    ]
    const result = computeOnTime(stops)
    // Only the first row is a valid completed stop.
    expect(result.completed).toBe(1)
    expect(result.onTime).toBe(1)
  })

  it('low-n at exactly 20 valid stops after dropping invalid rows', () => {
    // 20 valid + 1 invalid → completed counts only the 20 valid (at-n).
    const valid = Array.from({ length: 20 }, () =>
      stop('2026-06-16T05:00:00Z', '2026-06-16'),
    )
    const invalid: OnTimeStop = {
      completed_at: null as unknown as string,
      scheduledDate: '2026-06-16',
    }
    const result = computeOnTime([...valid, invalid])
    expect(result.completed).toBe(20)
    expect(result.isLowN).toBe(false)
    expect(result.pct).toBe(100)
  })
})
