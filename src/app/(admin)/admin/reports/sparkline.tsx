'use client'

/**
 * Rolling-12 sparkline (VER-297 trendlines, design review 02/07 F-004).
 *
 * Pure renderer: callers pass pre-bucketed month points (from the monthly
 * RPCs — never row-fetch-then-bucket client-side, max_rows=1000) that are
 * already ZERO-FILLED across the window (zeroFillMonths) so lines align
 * across time. Replaces the old bar strip, whose all-zero months rendered as
 * a row of faint dashes that read as broken underlines; an all-zero window
 * now draws a flat baseline — unmistakably intentional. Rendered in the
 * <SlaCard> footer slot, pinned to the card bottom. The go-live cliff is a
 * data property, not a bug — the caption says so (definitions doc v1.0 §2).
 *
 * Accessibility: SVG children are presentational, so the data summary lives
 * in the aria-label (latest month + peak) plus a <title> tooltip.
 */

export interface TrendPoint {
  /** `YYYY-MM` (or `YYYY-MM-DD` — only the month prefix is displayed). */
  month: string
  value: number
}

/**
 * '2026-03' → 'Mar 2026' for the aria summary + tooltip. Fixed lookup, not
 * Intl.DateTimeFormat — ICU short-month output is locale/runtime-dependent
 * (en-AU renders "June", CI ICU builds vary), and the label feeds test
 * assertions and screen-reader output that must be deterministic.
 */
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTH_ABBR[(m! - 1 + 12) % 12]} ${y}`
}

// viewBox geometry: 100 wide, 28 tall; 2px headroom, baseline at y=26.
const W = 100
const BASE = 26
const TOP = 2

export function Sparkline({
  points,
  caption,
}: {
  points: TrendPoint[]
  /** e.g. "Completed stops · last 12 months". */
  caption?: string
}) {
  if (points.length === 0) return null
  const max = Math.max(...points.map((p) => p.value), 1)
  const latest = points[points.length - 1]!
  const peak = points.reduce((a, b) => (b.value > a.value ? b : a))
  const summary = `${caption ?? 'Monthly trend'} — latest ${monthLabel(latest.month.slice(0, 7))}: ${latest.value}; peak ${monthLabel(peak.month.slice(0, 7))}: ${peak.value}`

  const xy = points.map((p, i) => {
    const x = points.length === 1 ? W : (i / (points.length - 1)) * W
    const y = BASE - (p.value / max) * (BASE - TOP)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const line = xy.join(' ')
  const area = `0,${BASE} ${line} ${W},${BASE}`

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} 28`}
        preserveAspectRatio="none"
        className="h-8 w-full"
        role="img"
        aria-label={summary}
      >
        <title>{summary}</title>
        <polygon points={area} fill="#293F52" fillOpacity="0.08" />
        <polyline
          points={line}
          fill="none"
          stroke="#293F52"
          strokeOpacity="0.85"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {caption && <p className="mt-1 text-[10px] text-gray-500">{caption}</p>}
    </div>
  )
}
