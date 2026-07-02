'use client'

/**
 * Tiny presentational rolling-12 bar strip (VER-297 trendlines).
 *
 * Pure renderer: callers pass pre-bucketed month points (from the monthly
 * RPCs — never row-fetch-then-bucket client-side, max_rows=1000). Bars scale
 * to the series max. The go-live cliff is a data property, not a bug — the
 * strip carries its own caption so a council reading months of zeros before
 * platform adoption sees why (definitions doc v1.0 §2).
 */

export interface TrendPoint {
  /** `YYYY-MM` (or `YYYY-MM-DD` — only the month prefix is displayed). */
  month: string
  value: number
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

  return (
    <div>
      <div className="flex h-8 items-end gap-[3px]" role="img" aria-label={caption ?? 'Monthly trend'}>
        {points.map((p) => (
          <div
            key={p.month}
            title={`${p.month.slice(0, 7)}: ${p.value}`}
            className="flex-1 rounded-sm bg-[#293F52]/80"
            style={{ height: `${Math.max(4, (p.value / max) * 100)}%`, minWidth: 3 }}
          />
        ))}
      </div>
      {caption && <p className="mt-1 text-[10px] text-gray-400">{caption}</p>}
    </div>
  )
}
