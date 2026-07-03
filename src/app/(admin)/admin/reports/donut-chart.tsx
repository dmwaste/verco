'use client'

/**
 * Donut chart + legend for the reports surface (design feedback 02/07:
 * Service Breakdown, NCN Types and the Prefer This Service panel).
 *
 * Pure renderer: callers pass pre-aggregated segments with resolved colours.
 * Zero-total series render nothing — the caller owns the empty state.
 * Segments are stroke-dash arcs on a single ring, starting at 12 o'clock.
 *
 * Accessibility: the SVG is one graphic — the data summary lives in the
 * aria-label and the adjacent legend list carries every label + count as
 * real text.
 */

export interface DonutSegment {
  label: string
  value: number
  color: string
}

const R = 38
const CIRC = 2 * Math.PI * R

export function DonutChart({
  segments,
  ariaLabel,
  svgClassName = 'h-28 w-28',
}: {
  segments: DonutSegment[]
  /** e.g. "Service breakdown". Segment values are appended automatically. */
  ariaLabel: string
  /** Ring size override — chart panels run larger than card footers. */
  svgClassName?: string
}) {
  const visible = segments.filter((s) => s.value > 0)
  const total = visible.reduce((sum, s) => sum + s.value, 0)
  if (total === 0) return null

  // Scan (not map-with-mutation — react-hooks/immutability): each arc starts
  // where the previous one ended.
  const arcs = visible.reduce<Array<DonutSegment & { len: number; offset: number }>>(
    (acc, s) => {
      const prev = acc[acc.length - 1]
      const offset = prev ? prev.offset + prev.len : 0
      acc.push({ ...s, len: (s.value / total) * CIRC, offset })
      return acc
    },
    [],
  )
  const summary = `${ariaLabel} — ${visible
    .map((s) => `${s.label}: ${s.value}`)
    .join('; ')}`

  return (
    <div className="flex items-center gap-6">
      <svg
        viewBox="0 0 100 100"
        className={`${svgClassName} shrink-0`}
        role="img"
        aria-label={summary}
      >
        <title>{summary}</title>
        {/* Track ring — visible when a single tiny segment would look lost. */}
        <circle cx="50" cy="50" r={R} fill="none" stroke="#F3F4F6" strokeWidth="15" />
        {arcs.map((a, i) => (
          <circle
            key={`${a.label}-${i}`}
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={a.color}
            strokeWidth="15"
            strokeDasharray={`${a.len} ${CIRC - a.len}`}
            strokeDashoffset={-a.offset}
            transform="rotate(-90 50 50)"
          />
        ))}
      </svg>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {visible.map((s, i) => (
          <li key={`${s.label}-${i}`} className="flex items-center gap-2 text-body-sm">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            <span className="min-w-0 flex-1 truncate text-gray-600">{s.label}</span>
            <span className="font-semibold text-gray-700">{s.value}</span>
            <span className="w-12 text-right text-caption text-gray-500">
              {((s.value / total) * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
