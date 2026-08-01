import { zeroFillMonths } from '@/lib/reports/periods'

/**
 * Mattresses Collected card maths (#487). Rows come from the
 * `get_mattress_daily` RPC — day-granular long format with two sources:
 *   mattress_booked  booking_item units of is_mattress services (KWN-style)
 *   mattress_logged  crew-logged collection_stop.mattress_count (VV-style)
 * A tenant only ever populates one source, but the fold treats them
 * uniformly so a future council could legitimately have both.
 */

export interface MattressDailyRow {
  /** YYYY-MM-DD */
  day: string
  series: string
  value: number
}

export const MATTRESS_SERIES = {
  booked: 'mattress_booked',
  logged: 'mattress_logged',
} as const

export interface MattressTotals {
  total: number
  booked: number
  logged: number
  isEmpty: boolean
}

export function computeMattressTotals(
  rows: readonly MattressDailyRow[],
): MattressTotals {
  let booked = 0
  let logged = 0
  for (const r of rows) {
    if (r.series === MATTRESS_SERIES.booked) booked += r.value
    else if (r.series === MATTRESS_SERIES.logged) logged += r.value
  }
  return { total: booked + logged, booked, logged, isEmpty: rows.length === 0 }
}

/**
 * Month-bucketed totals (both sources summed) zero-filled across the window —
 * a mattressless month IS 0, matching the volume-series convention.
 */
export function mattressMonthlyPoints(
  rows: readonly MattressDailyRow[],
  anchorIso: string,
  nowUtc: Date,
): Array<{ month: string; value: number }> {
  const byMonth = new Map<string, number>()
  for (const r of rows) {
    if (r.series !== MATTRESS_SERIES.booked && r.series !== MATTRESS_SERIES.logged) continue
    const m = r.day.slice(0, 7)
    byMonth.set(m, (byMonth.get(m) ?? 0) + r.value)
  }
  const observed = [...byMonth.entries()].map(([m, value]) => ({
    month: `${m}-01`,
    value,
  }))
  return zeroFillMonths(observed, anchorIso, nowUtc)
}
