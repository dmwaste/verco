'use client'

/**
 * Presentational KPI card for /admin/reports (VER-179 spec §5.6, uniform
 * anatomy per design review 02/07 — Draxlr-style reference).
 *
 * Pure renderer — every metric card computes its own value/sub/tone from a
 * tested pure fn and hands display strings here. ONE anatomy, fixed order,
 * for every card on the reports surface:
 *
 *   LABEL          top-left, uppercase 11px
 *   VALUE          centred, dominant (text-4xl), tone-coloured
 *   PERIOD         centred under the value (the VER-290 provenance line)
 *   SUB            centred context (denominator / empty-state message)
 *   TARGET         centred reference line
 *   FOOTER         pinned to the card bottom (rolling-12 <Sparkline>)
 *
 * Empty states live in SUB (muted, small) under an em-dash VALUE — never in
 * the value slot, where a long phrase renders louder than real data.
 *
 * Colour rule (spec §5.6): pass/fail tone is only ever green (at/above
 * target) or amber (below) — NEVER error-red pre-go-live. Insight, empty and
 * low-`n` cards use the neutral navy tone. Metadata text is gray-500, not
 * gray-400 — the stamp is load-bearing (live vs month-stale must read
 * differently) and 10px gray-400 fails WCAG AA (~2.8:1).
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
  /** Headline value — short: a %, fraction, count or currency. Empty-state text belongs in `sub`. */
  value: string
  /** Loading flag — shows a skeleton dash while the query runs. */
  isLoading?: boolean
  /** Secondary context line (denominator, empty-state message, footnote). */
  sub?: string
  /** Colour tone — defaults to neutral (insight / empty / low-n). */
  tone?: SlaTone
  /** Optional reference line, e.g. "Target ≥ 98%". */
  target?: string
  /**
   * Freshness + period stamp (VER-290), e.g. "Live · This month" or
   * "Data as at Jun 2026" — rendered directly under the value so live and
   * month-stale figures are never read as the same thing.
   */
  provenance?: string
  /** Optional bottom slot — e.g. a rolling-12 <Sparkline> strip (VER-297). */
  footer?: React.ReactNode
  /**
   * Query failure flag. A failed fetch must NEVER read as an authoritative
   * zero/empty on a council-facing SLA card — it renders an explicit
   * "Couldn't load" state instead (review 02/07, adversarial finding 3).
   */
  isError?: boolean
}

export function SlaCard({
  label,
  value,
  isLoading = false,
  sub,
  tone = 'neutral',
  target,
  provenance,
  footer,
  isError = false,
}: SlaCardProps) {
  if (isError) {
    return (
      <div className="flex min-h-[164px] flex-col rounded-xl bg-white p-5 shadow-sm">
        <CardLabel text={label} />
        <div className="flex flex-1 flex-col items-center justify-center py-2 text-center">
          <p className="font-[family-name:var(--font-heading)] text-xl font-bold text-amber-600">
            Couldn&apos;t load
          </p>
          <p className="mt-1 text-caption text-gray-500">
            Data failed to refresh — reload the page or try again shortly.
          </p>
          {provenance && <p className="mt-1 text-caption text-gray-500">{provenance}</p>}
        </div>
      </div>
    )
  }
  return (
    <div className="flex min-h-[164px] flex-col rounded-xl bg-white p-5 shadow-sm">
      <CardLabel text={label} />
      <div className="flex flex-1 flex-col items-center justify-center py-2 text-center">
        <p
          className={`font-[family-name:var(--font-heading)] text-4xl font-bold leading-tight ${TONE_CLASS[tone]}`}
        >
          {isLoading ? '—' : value}
        </p>
        {provenance && (
          <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
            {provenance}
          </p>
        )}
        {sub && !isLoading && <p className="mt-1 text-caption text-gray-500">{sub}</p>}
        {target && !isLoading && (
          <p className="mt-0.5 text-caption font-medium text-gray-500">{target}</p>
        )}
      </div>
      {footer && !isLoading && <div className="mt-auto pt-2">{footer}</div>}
    </div>
  )
}

/** Uppercase card label — shared with the chart panels so the level reads the same everywhere. */
export function CardLabel({ text }: { text: string }) {
  return (
    <p className="text-caption font-semibold uppercase tracking-wide text-gray-500">{text}</p>
  )
}

/**
 * VER-290 freshness/period stamp for CHART panels (Service Breakdown, NCN
 * Types, Prefer This Service — anything hand-rolled with its own body). KPI
 * cards render the stamp inside <SlaCard> under the value instead. gray-500:
 * the stamp is load-bearing and must clear readable contrast (gray-400 at
 * 10px fails WCAG AA).
 */
export function ProvenanceStamp({ text }: { text: string }) {
  return (
    <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
      {text}
    </p>
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
