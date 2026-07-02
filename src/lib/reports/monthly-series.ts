/**
 * Long-format monthly series → sparkline points (design 02/07: every
 * single-value card carries a rolling-12 tail).
 *
 * `get_reports_monthly` returns (month, series, value) rows; these pure fns
 * fold them into the two sparkline shapes:
 *
 *   countPoints    volumes (bookings, tickets) — ZERO-FILLED across the
 *                  window: a month with no bookings genuinely IS 0.
 *   percentPoints  rates (clean %, self-service %, delivered %, rect %,
 *                  response %, csat %) — observed months ONLY: a month with
 *                  no denominator is "no data", never 0%.
 *
 * Deterministic: callers pass the window anchor + now (no wall-clock reads).
 */

import { zeroFillMonths } from '@/lib/reports/periods'

export interface MonthlySeriesRow {
  /** `YYYY-MM-DD` month start (Postgres date). */
  month: string
  series: string
  value: number
}

export interface MonthlyPoint {
  month: string
  value: number
}

/** Round to 1 dp — matches the cards' pct1 display precision. */
function pct1Value(num: number, den: number): number {
  return Math.round((num / den) * 1000) / 10
}

/** Volume series, zero-filled from `anchor` through the month of `now`. */
export function countPoints(
  rows: readonly MonthlySeriesRow[],
  series: string,
  anchor: string,
  now: Date,
): MonthlyPoint[] {
  const observed = rows
    .filter((r) => r.series === series)
    .map((r) => ({ month: String(r.month).slice(0, 10), value: Number(r.value) }))
  return zeroFillMonths(observed, anchor, now)
}

/**
 * Rate series: months where the denominator series is > 0, value = num/den %.
 * A missing numerator row for an observed denominator month counts as 0.
 */
export function percentPoints(
  rows: readonly MonthlySeriesRow[],
  numSeries: string,
  denSeries: string,
): MonthlyPoint[] {
  const num = new Map<string, number>()
  for (const r of rows) {
    if (r.series === numSeries) num.set(String(r.month).slice(0, 10), Number(r.value))
  }
  return rows
    .filter((r) => r.series === denSeries && Number(r.value) > 0)
    .map((r) => {
      const month = String(r.month).slice(0, 10)
      return { month, value: pct1Value(num.get(month) ?? 0, Number(r.value)) }
    })
    .sort((a, b) => (a.month < b.month ? -1 : 1))
}

/**
 * Clean-collection rate: (eligible − contractor-fault miss) / eligible %,
 * per month with eligible > 0 — mirrors clean-collection.ts.
 */
export function cleanCollectionPoints(rows: readonly MonthlySeriesRow[]): MonthlyPoint[] {
  const miss = new Map<string, number>()
  for (const r of rows) {
    if (r.series === 'bc_miss') miss.set(String(r.month).slice(0, 10), Number(r.value))
  }
  return rows
    .filter((r) => r.series === 'bc_eligible' && Number(r.value) > 0)
    .map((r) => {
      const month = String(r.month).slice(0, 10)
      const eligible = Number(r.value)
      const clean = Math.max(0, eligible - (miss.get(month) ?? 0))
      return { month, value: pct1Value(clean, eligible) }
    })
    .sort((a, b) => (a.month < b.month ? -1 : 1))
}
