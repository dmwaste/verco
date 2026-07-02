'use client'

/**
 * Presentational SLA card for the VER-179 dashboard (spec §5.6).
 *
 * Pure renderer — every metric card (scorecard or insight) computes its own
 * value/sub/tone from a tested pure fn and hands the display strings here. Card
 * chrome matches the existing admin summary cards exactly (reports-client.tsx):
 * `rounded-xl bg-white p-5 shadow-sm`, an uppercase gray label, and a navy
 * heading-font numeral.
 *
 * Colour rule (spec §5.6): a pass/fail tone is only ever green (at/above target)
 * or amber (below) — NEVER error-red pre-go-live. Insight cards, empty cards and
 * low-`n` cards use the neutral navy tone (no pass/fail signal).
 */

export type SlaTone = 'pass' | 'below' | 'neutral'

const TONE_CLASS: Record<SlaTone, string> = {
  pass: 'text-emerald-600',
  below: 'text-amber-600',
  neutral: 'text-[#293F52]',
}

export interface SlaCardProps {
  /** Uppercase card label, e.g. "Clean Collection". */
  label: string
  /** Headline value: a percentage, a raw fraction, or an empty-state notice. */
  value: string
  /** Loading flag — shows a skeleton dash while the query runs. */
  isLoading?: boolean
  /** Secondary context line (denominator, "Building data", footnote). */
  sub?: string
  /** Colour tone — defaults to neutral (insight / empty / low-n). */
  tone?: SlaTone
  /** Optional reference line, e.g. "Target ≥ 98%". */
  target?: string
}

export function SlaCard({
  label,
  value,
  isLoading = false,
  sub,
  tone = 'neutral',
  target,
}: SlaCardProps) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </p>
      <p
        className={`mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold ${TONE_CLASS[tone]}`}
      >
        {isLoading ? '—' : value}
      </p>
      {sub && !isLoading && <p className="mt-0.5 text-[11px] text-gray-500">{sub}</p>}
      {target && !isLoading && (
        <p className="mt-1 text-[11px] font-medium text-gray-400">{target}</p>
      )}
    </div>
  )
}

/**
 * Shared tone picker for scorecards: neutral below the low-`n` threshold or when
 * empty, otherwise green at/above target and amber below it. Insight cards do
 * NOT use this — they are always neutral.
 */
export function scorecardTone(
  pct: number | null,
  targetPct: number,
  opts: { isEmpty: boolean; isLowN: boolean },
): SlaTone {
  if (opts.isEmpty || opts.isLowN || pct === null) return 'neutral'
  return pct >= targetPct ? 'pass' : 'below'
}
