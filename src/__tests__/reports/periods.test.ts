import { describe, expect, it } from 'vitest'
import {
  awstTimestampBounds,
  resolvePeriod,
  rolling12From,
  zeroFillMonths,
  type PeriodFyRow,
} from '@/lib/reports/periods'

// 2026-07-02 10:00 AWST = 2026-07-02 02:00 UTC (a Thursday).
const NOW = new Date('2026-07-02T02:00:00Z')
// 23:30 AWST on 2026-07-02 = 15:30 UTC — same AWST day, previous-UTC-day trap.
const NOW_LATE_AWST = new Date('2026-07-02T15:30:00Z')

const FY26: PeriodFyRow = {
  id: 'fy26',
  label: 'FY26',
  start_date: '2025-07-01',
  end_date: '2026-06-30',
  is_current: false,
}
const FY27: PeriodFyRow = {
  id: 'fy27',
  label: 'FY27',
  start_date: '2026-07-01',
  end_date: '2027-06-30',
  is_current: true,
}
const FYS = [FY26, FY27]

describe('resolvePeriod (VER-297 standard slicers)', () => {
  it('this-week runs Mon–Sun AWST containing today', () => {
    const p = resolvePeriod('this-week', NOW, FYS)
    expect(p).toMatchObject({ from: '2026-06-29', to: '2026-07-05', kind: 'range', fyId: 'fy27' })
  })

  it('last-week is the prior Mon–Sun', () => {
    const p = resolvePeriod('last-week', NOW, FYS)
    expect(p).toMatchObject({ from: '2026-06-22', to: '2026-06-28' })
  })

  it('uses the AWST calendar date, not the UTC date, near midnight', () => {
    // 15:30 UTC is still 02/07 AWST — same week/month as NOW, not the UTC day.
    expect(resolvePeriod('this-week', NOW_LATE_AWST, FYS)).toMatchObject({
      from: '2026-06-29',
      to: '2026-07-05',
    })
    expect(resolvePeriod('this-month', NOW_LATE_AWST, FYS)).toMatchObject({
      from: '2026-07-01',
      to: '2026-07-31',
    })
  })

  it('this-month and last-month use calendar boundaries incl. year rollover', () => {
    expect(resolvePeriod('this-month', NOW, FYS)).toMatchObject({
      from: '2026-07-01',
      to: '2026-07-31',
    })
    expect(resolvePeriod('last-month', NOW, FYS)).toMatchObject({
      from: '2026-06-01',
      to: '2026-06-30',
    })
    const jan = resolvePeriod('last-month', new Date('2026-01-05T02:00:00Z'), FYS)
    expect(jan).toMatchObject({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('FY presets scope by fyId with the FY dates as bounds', () => {
    expect(resolvePeriod('this-fy', NOW, FYS)).toMatchObject({
      from: '2026-07-01',
      to: '2027-06-30',
      kind: 'fy',
      fyId: 'fy27',
      label: 'This FY (FY27)',
    })
    expect(resolvePeriod('last-fy', NOW, FYS)).toMatchObject({
      from: '2025-07-01',
      to: '2026-06-30',
      kind: 'fy',
      fyId: 'fy26',
      label: 'Last FY (FY26)',
    })
  })

  it('missing FY rows yield null bounds rather than silently widening', () => {
    expect(resolvePeriod('this-fy', NOW, [])).toMatchObject({ from: null, to: null, fyId: null })
    // Only the current FY exists → no prior FY row.
    expect(resolvePeriod('last-fy', NOW, [FY27])).toMatchObject({ from: null, to: null, fyId: null })
  })

  it('custom keeps valid bounds and drops malformed ones', () => {
    expect(resolvePeriod('custom', NOW, FYS, { from: '2026-01-01', to: '2026-02-01' })).toMatchObject({
      from: '2026-01-01',
      to: '2026-02-01',
      kind: 'range',
    })
    expect(resolvePeriod('custom', NOW, FYS, { from: 'not-a-date' })).toMatchObject({
      from: null,
      to: null,
    })
  })

  it('rolling12From is the 1st of the month 11 months back (AWST)', () => {
    expect(rolling12From(NOW)).toBe('2025-08-01')
    expect(rolling12From(NOW_LATE_AWST)).toBe('2025-08-01')
    expect(rolling12From(new Date('2026-01-05T02:00:00Z'))).toBe('2025-02-01')
  })

  // ── Review additions (02/07): boundary + anomaly coverage ─────────────────

  it('this-week on a Sunday still starts the preceding Monday (dow wrap)', () => {
    const sun = new Date('2026-07-05T02:00:00Z') // Sunday AWST
    expect(resolvePeriod('this-week', sun, FYS)).toMatchObject({ from: '2026-06-29', to: '2026-07-05' })
  })

  it('this-week on a Monday starts today', () => {
    const mon = new Date('2026-06-29T02:00:00Z')
    expect(resolvePeriod('this-week', mon, FYS)).toMatchObject({ from: '2026-06-29', to: '2026-07-05' })
  })

  it('last-fy picks the LATEST prior FY when several exist', () => {
    const FY25: PeriodFyRow = {
      id: 'fy25',
      label: 'FY25',
      start_date: '2024-07-01',
      end_date: '2025-06-30',
      is_current: false,
    }
    expect(resolvePeriod('last-fy', NOW, [FY25, FY27, FY26])).toMatchObject({
      fyId: 'fy26',
      from: '2025-07-01',
      to: '2026-06-30',
    })
  })

  it('this-fy with a duplicate is_current anomaly resolves the first current row', () => {
    const dupe = [FY27, { ...FY26, is_current: true }]
    expect(resolvePeriod('this-fy', NOW, dupe)).toMatchObject({ fyId: 'fy27', unresolved: false })
  })

  it('custom drops a malformed to while keeping a valid from', () => {
    expect(resolvePeriod('custom', NOW, FYS, { from: '2026-01-01', to: '31/01/2026' })).toMatchObject({
      from: '2026-01-01',
      to: null,
      unresolved: false,
    })
  })

  it('unresolved: FY presets with no matching row, and Custom with no dates', () => {
    // Silent all-time widening under a period stamp is the failure this guards.
    expect(resolvePeriod('this-fy', NOW, []).unresolved).toBe(true)
    expect(resolvePeriod('last-fy', NOW, [FY27]).unresolved).toBe(true)
    expect(resolvePeriod('custom', NOW, FYS).unresolved).toBe(true)
    expect(resolvePeriod('custom', NOW, FYS, { from: '2026-01-01' }).unresolved).toBe(false)
    expect(resolvePeriod('this-week', NOW, []).unresolved).toBe(false) // date presets never need FY rows
  })

  it('custom label carries the chosen dates', () => {
    expect(resolvePeriod('custom', NOW, FYS, { from: '2026-01-01', to: '2026-02-01' }).label).toBe(
      'Custom (2026-01-01 – 2026-02-01)',
    )
    expect(resolvePeriod('custom', NOW, FYS, { from: '2026-01-01' }).label).toBe('Custom (2026-01-01 – …)')
  })
})

describe('awstTimestampBounds', () => {
  it('produces an inclusive AWST start and an EXCLUSIVE next-day-midnight end', () => {
    expect(awstTimestampBounds({ from: '2026-07-01', to: '2026-07-31' })).toEqual({
      gte: '2026-07-01T00:00:00+08:00',
      lt: '2026-08-01T00:00:00+08:00', // .lt — includes 23:59:59.999 on the 31st
    })
  })

  it('leaves null sides unbounded', () => {
    expect(awstTimestampBounds({ from: null, to: null })).toEqual({ gte: null, lt: null })
    expect(awstTimestampBounds({ from: '2026-07-01', to: null })).toEqual({
      gte: '2026-07-01T00:00:00+08:00',
      lt: null,
    })
  })
})

describe('zeroFillMonths', () => {
  it('fills the full window with zeros so trend bars align across time', () => {
    const filled = zeroFillMonths(
      [
        { month: '2025-08-01', value: 3 },
        { month: '2025-11-01', value: 7 },
      ],
      '2025-08-01',
      NOW, // AWST July 2026 → 12-month window Aug 2025 … Jul 2026
    )
    expect(filled).toHaveLength(12)
    expect(filled[0]).toEqual({ month: '2025-08-01', value: 3 })
    expect(filled[1]).toEqual({ month: '2025-09-01', value: 0 }) // elided by the RPC, restored here
    expect(filled[3]).toEqual({ month: '2025-11-01', value: 7 })
    expect(filled[11]).toEqual({ month: '2026-07-01', value: 0 }) // zero current month still renders
  })

  it('handles the year rollover and an empty input', () => {
    const filled = zeroFillMonths([], '2025-11-01', new Date('2026-02-10T02:00:00Z'))
    expect(filled.map((p) => p.month)).toEqual([
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ])
    expect(filled.every((p) => p.value === 0)).toBe(true)
  })
})
