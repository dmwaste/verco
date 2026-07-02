'use client'

/**
 * Tiny presentational rolling-12 bar strip (VER-297 trendlines).
 *
 * Pure renderer: callers pass pre-bucketed month points (from the monthly
 * RPCs — never row-fetch-then-bucket client-side, max_rows=1000) that are
 * already ZERO-FILLED across the window (zeroFillMonths) so bars align across
 * time. Bars scale to the series max. The go-live cliff is a data property,
 * not a bug — the strip carries its own caption so a council reading months
 * of zeros before platform adoption sees why (definitions doc v1.0 §2).
 *
 * Accessibility: children of role="img" are presentational, so the data
 * summary lives in the aria-label (latest month + peak), not only in the
 * pointer-only title tooltips.
 */

export interface TrendPoint {
  /** `YYYY-MM` (or `YYYY-MM-DD` — only the month prefix is displayed). */
  month: string
  value: number
}

/**
 * '2026-03' → 'Mar 2026' for tooltips + the aria summary. Fixed lookup, not
 * Intl.DateTimeFormat — ICU short-month output is locale/runtime-dependent
 * (en-AU renders "June", CI ICU builds vary), and the label feeds test
 * assertions and screen-reader output that must be deterministic.
 */
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTH_ABBR[(m! - 1 + 12) % 12]} ${y}`
}

export function TrendBars({
  points,
  caption,
}: {
  points: TrendPoint[]
  /** e.g. "Last 12 months · history starts at platform adoption". */
  caption?: string
}) {
  if (points.length === 0) return null
  const max = Math.max(...points.map((p) => p.value), 1)
  const latest = points[points.length - 1]!
  const peak = points.reduce((a, b) => (b.value > a.value ? b : a))
  const summary = `${caption ?? 'Monthly trend'} — latest ${monthLabel(latest.month.slice(0, 7))}: ${latest.value}; peak ${monthLabel(peak.month.slice(0, 7))}: ${peak.value}`

  return (
    <div>
      <div className="flex h-8 items-end gap-[3px]" role="img" aria-label={summary}>
        {points.map((p) => (
          <div
            key={p.month}
            title={`${monthLabel(p.month.slice(0, 7))}: ${p.value}`}
            className="flex-1 rounded-sm bg-[#293F52]/80"
            style={{ height: `${Math.max(4, (p.value / max) * 100)}%`, minWidth: 3 }}
          />
        ))}
      </div>
      {caption && <p className="mt-1 text-[10px] text-gray-400">{caption}</p>}
    </div>
  )
}
