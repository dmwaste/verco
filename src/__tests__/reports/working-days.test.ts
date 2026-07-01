import { describe, it, expect } from 'vitest'
import { workingDaysBetween } from '@/lib/reports/working-days'

/**
 * `workingDaysBetween` counts Mon–Fri AWST dates strictly after `start` through
 * `end` (the half-open window `(start, end]`), then subtracts any WA public
 * holiday that falls on a counted weekday in that same window.
 *
 * Calendar anchors used below (verified, AWST = UTC+8, no DST):
 *   2026-06-15 Mon · 06-16 Tue · 06-17 Wed · 06-18 Thu · 06-19 Fri ·
 *   06-20 Sat · 06-21 Sun · 06-22 Mon
 *   2025-12-31 Wed · 2026-01-01 Thu (New Year's Day) · 2026-01-02 Fri
 *   2026-01-23 Fri · 01-24 Sat · 01-25 Sun · 2026-01-26 Mon (Australia Day)
 */
describe('workingDaysBetween', () => {
  it('returns 0 for the same day (start == end)', () => {
    expect(workingDaysBetween('2026-06-15', '2026-06-15', [])).toBe(0)
  })

  it('counts a single weekday: Mon → Tue is 1', () => {
    expect(workingDaysBetween('2026-06-15', '2026-06-16', [])).toBe(1)
  })

  it('skips the weekend: Fri → Mon is 1 (Sat/Sun excluded, Mon counted)', () => {
    expect(workingDaysBetween('2026-06-19', '2026-06-22', [])).toBe(1)
  })

  it('counts a full Mon→Fri working week as 4 working days', () => {
    // (Mon 06-15, Fri 06-19] = Tue, Wed, Thu, Fri = 4
    expect(workingDaysBetween('2026-06-15', '2026-06-19', [])).toBe(4)
  })

  it('subtracts a WA public holiday landing on a weekday in the window', () => {
    // (Wed 2025-12-31, Fri 2026-01-02] = Thu 01-01 + Fri 01-02 = 2 weekdays.
    // New Year's Day 2026-01-01 (Thu) is a holiday in (start, end] → minus 1.
    expect(workingDaysBetween('2025-12-31', '2026-01-02', ['2026-01-01'])).toBe(1)
  })

  it('without the holiday list the same span counts both weekdays', () => {
    expect(workingDaysBetween('2025-12-31', '2026-01-02', [])).toBe(2)
  })

  it('does not double-count a holiday that falls on a weekend (no negative skew)', () => {
    // (Fri 2026-01-23, Mon 2026-01-26] = Sat 24, Sun 25, Mon 26.
    // Only Mon is a weekday → base count 1. Holiday 2026-01-24 is a Saturday,
    // never counted, so subtracting it must NOT reduce the result below 1.
    expect(workingDaysBetween('2026-01-23', '2026-01-26', ['2026-01-24'])).toBe(1)
  })

  it('subtracts a weekday holiday but ignores a weekend holiday in the same window', () => {
    // Same span; Australia Day 2026-01-26 (Mon, weekday) IS subtracted,
    // the weekend holiday 2026-01-24 is not → 1 - 1 = 0.
    expect(
      workingDaysBetween('2026-01-23', '2026-01-26', ['2026-01-24', '2026-01-26']),
    ).toBe(0)
  })

  it('ignores a holiday that falls outside the (start, end] window', () => {
    // Holiday equal to the start date is excluded (half-open lower bound).
    expect(workingDaysBetween('2026-01-01', '2026-01-02', ['2026-01-01'])).toBe(1)
  })

  it('includes a holiday exactly on the end date (closed upper bound)', () => {
    // (Wed 2025-12-31, Thu 2026-01-01] = Thu only = 1 weekday; holiday on the
    // end date 2026-01-01 is in the window → 1 - 1 = 0.
    expect(workingDaysBetween('2025-12-31', '2026-01-01', ['2026-01-01'])).toBe(0)
  })

  it('returns 0 when end is before start (reversed range)', () => {
    expect(workingDaysBetween('2026-06-16', '2026-06-15', [])).toBe(0)
  })

  it('returns 0 for a weekend-only span (Sat → Sun)', () => {
    expect(workingDaysBetween('2026-06-20', '2026-06-21', [])).toBe(0)
  })

  it('normalises ISO timestamps to the AWST calendar date (midnight boundary)', () => {
    // start = 2026-06-15T17:00Z = 2026-06-16T01:00 AWST → AWST date 06-16.
    // end   = 2026-06-16T17:00Z = 2026-06-17T01:00 AWST → AWST date 06-17.
    // (06-16, 06-17] = Wed only = 1 working day. A naive UTC ::date would have
    // bucketed start to 06-15 and counted 2.
    expect(
      workingDaysBetween('2026-06-15T17:00:00Z', '2026-06-16T17:00:00Z', []),
    ).toBe(1)
  })

  it('treats a bare YYYY-MM-DD and its AWST-equivalent timestamp identically', () => {
    const fromDates = workingDaysBetween('2026-06-15', '2026-06-19', [])
    // 2026-06-14T16:00Z = 2026-06-15T00:00 AWST; 2026-06-18T16:00Z = 06-19T00:00 AWST
    const fromTimestamps = workingDaysBetween(
      '2026-06-14T16:00:00Z',
      '2026-06-18T16:00:00Z',
      [],
    )
    expect(fromTimestamps).toBe(fromDates)
    expect(fromTimestamps).toBe(4)
  })

  it('accepts a Set of holidays (Iterable), not just an array', () => {
    expect(
      workingDaysBetween('2025-12-31', '2026-01-02', new Set(['2026-01-01'])),
    ).toBe(1)
  })

  it('counts across a multi-week span with two weekday holidays', () => {
    // (Mon 2026-06-15, Mon 2026-06-29] spans:
    //   wk1: Tue16 Wed17 Thu18 Fri19          = 4
    //   wk2: Mon22 Tue23 Wed24 Thu25 Fri26    = 5
    //   Mon29                                 = 1   → 10 weekdays.
    // Two holidays on weekdays inside the window → 10 - 2 = 8.
    expect(
      workingDaysBetween('2026-06-15', '2026-06-29', ['2026-06-17', '2026-06-22']),
    ).toBe(8)
  })

  it('does not subtract a duplicate holiday twice', () => {
    expect(
      workingDaysBetween('2025-12-31', '2026-01-02', ['2026-01-01', '2026-01-01']),
    ).toBe(1)
  })
})
