import { describe, expect, it } from 'vitest'
import {
  computeMattressTotals,
  mattressMonthlyPoints,
  type MattressDailyRow,
} from '@/lib/reports/mattresses'

// 2026-07-02 10:00 AWST.
const NOW = new Date('2026-07-02T02:00:00Z')

const rows: MattressDailyRow[] = [
  { day: '2026-05-04', series: 'mattress_booked', value: 3 },
  { day: '2026-05-11', series: 'mattress_booked', value: 2 },
  { day: '2026-05-11', series: 'mattress_logged', value: 1 },
  { day: '2026-07-01', series: 'mattress_logged', value: 4 },
]

describe('computeMattressTotals', () => {
  it('sums the two sources separately and together', () => {
    expect(computeMattressTotals(rows)).toEqual({
      total: 10,
      booked: 5,
      logged: 5,
      isEmpty: false,
    })
  })

  it('flags empty when there are no rows', () => {
    expect(computeMattressTotals([])).toEqual({
      total: 0,
      booked: 0,
      logged: 0,
      isEmpty: true,
    })
  })

  it('ignores unknown series rather than silently counting them', () => {
    const withStray: MattressDailyRow[] = [
      ...rows,
      { day: '2026-05-04', series: 'something_else', value: 100 },
    ]
    expect(computeMattressTotals(withStray).total).toBe(10)
  })
})

describe('mattressMonthlyPoints', () => {
  it('sums BOTH series into month buckets and zero-fills the window', () => {
    expect(mattressMonthlyPoints(rows, '2026-05-01', NOW)).toEqual([
      { month: '2026-05-01', value: 6 },
      { month: '2026-06-01', value: 0 }, // no mattresses that month IS 0
      { month: '2026-07-01', value: 4 },
    ])
  })

  it('multiple days in one month accumulate — never overwrite', () => {
    const may: MattressDailyRow[] = [
      { day: '2026-05-04', series: 'mattress_booked', value: 3 },
      { day: '2026-05-05', series: 'mattress_booked', value: 3 },
    ]
    expect(mattressMonthlyPoints(may, '2026-05-01', NOW)[0]).toEqual({
      month: '2026-05-01',
      value: 6,
    })
  })
})
