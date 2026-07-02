import { describe, expect, it } from 'vitest'
import {
  resolvePeriod,
  rolling12From,
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
})
