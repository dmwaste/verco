import { describe, expect, it } from 'vitest'
import {
  cleanCollectionPoints,
  countPoints,
  percentPoints,
  type MonthlySeriesRow,
} from '@/lib/reports/monthly-series'

// 2026-07-02 10:00 AWST.
const NOW = new Date('2026-07-02T02:00:00Z')

const rows: MonthlySeriesRow[] = [
  { month: '2026-05-01', series: 'bookings', value: 3 },
  { month: '2026-07-01', series: 'bookings', value: 8 },
  { month: '2026-05-01', series: 'resp_den', value: 4 },
  { month: '2026-05-01', series: 'resp_num', value: 3 },
  { month: '2026-06-01', series: 'resp_den', value: 0 }, // zero denominator → skipped
  { month: '2026-07-01', series: 'resp_den', value: 2 }, // no num row → 0%
  { month: '2026-05-01', series: 'bc_eligible', value: 40 },
  { month: '2026-05-01', series: 'bc_miss', value: 2 },
  { month: '2026-07-01', series: 'bc_eligible', value: 10 },
]

describe('countPoints', () => {
  it('zero-fills volume series across the window (a bookingless month IS 0)', () => {
    const pts = countPoints(rows, 'bookings', '2026-05-01', NOW)
    expect(pts).toEqual([
      { month: '2026-05-01', value: 3 },
      { month: '2026-06-01', value: 0 },
      { month: '2026-07-01', value: 8 },
    ])
  })

  it('ignores other series', () => {
    const pts = countPoints(rows, 'tickets', '2026-06-01', NOW)
    expect(pts.every((p) => p.value === 0)).toBe(true)
  })
})

describe('percentPoints', () => {
  it('emits only months with a positive denominator — no-data is never 0%', () => {
    const pts = percentPoints(rows, 'resp_num', 'resp_den')
    expect(pts).toEqual([
      { month: '2026-05-01', value: 75 },
      { month: '2026-07-01', value: 0 }, // observed den, missing num row → 0%
    ])
  })
})

describe('cleanCollectionPoints', () => {
  it('computes (eligible − miss)/eligible per observed month', () => {
    const pts = cleanCollectionPoints(rows)
    expect(pts).toEqual([
      { month: '2026-05-01', value: 95 }, // 38/40
      { month: '2026-07-01', value: 100 }, // no miss row
    ])
  })
})
