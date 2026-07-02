/**
 * NCN reasons breakdown (design 02/07 batch 5): top-N reasons + an "Other"
 * bucket for the Insights donut. Pure + deterministic — caller fetches
 * period-windowed `non_conformance_notice.reason` rows.
 */

export interface NoticeReasonSlice {
  label: string
  value: number
}

/** Reasons with no value recorded still count — under a visible label. */
const UNSPECIFIED = 'Unspecified'

export function computeNoticeReasons(
  rows: readonly { reason: string | null }[],
  topN = 4,
): NoticeReasonSlice[] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const label = r.reason?.trim() || UNSPECIFIED
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const sorted = [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    // Deterministic: count desc, then label asc for ties.
    .sort((a, b) => b.value - a.value || (a.label < b.label ? -1 : 1))

  if (sorted.length <= topN) return sorted
  const top = sorted.slice(0, topN)
  const other = sorted.slice(topN).reduce((sum, s) => sum + s.value, 0)
  return [...top, { label: 'Other', value: other }]
}
