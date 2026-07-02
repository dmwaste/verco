import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { workingDaysBetween } from '@/lib/reports/working-days'

/**
 * RECT — Rectification within 2 working days (VER-179 SLA dashboard, spec §3.3).
 *
 * Pure mirror of the `get_rect_sla` SECURITY DEFINER RPC so the working-day
 * arithmetic is DB-independent + unit-testable to 100% (CLAUDE.md §14). No
 * Supabase, no network, no wall-clock: every row compares two STORED timestamps
 * (issue time vs rebooked-booking completion time) passed in by the caller.
 *
 * Per the WMRC contract the SLA is: ≥ 90% of NCN/NP rectifications completed
 * within 2 WA working days of being issued.
 *
 *   denominator = rows whose rebooked booking reached Completed
 *                 (`rebookedCompleted === true`)
 *   numerator   = those completed within ≤ 2 working days of issue
 *
 * In-flight rectifications (a rebook was raised but the booking has not yet
 * reached Completed — `rebookedCompleted === false`) are pending, not failures,
 * and are excluded from BOTH numerator and denominator. `pct` is null when the
 * denominator is 0 (nothing to measure).
 */

/** Target pass rate (%) — WMRC contract: ≥ 90%. */
export const RECT_TARGET_PCT = 90

/**
 * Minimum completed-rectification sample size before the card colours a
 * pass/fail percentage. Below it the consumer shows the raw fraction + a
 * "Building data" label (spec §3.3 LOW_N = 5). The pure fn always returns the
 * honest fraction regardless — the threshold is a render concern.
 */
export const RECT_LOW_N = 5

/** Maximum working days for a rectification to count as on-time. */
const RECT_TARGET_WD = 2

/**
 * One NCN/NP rectification row.
 *
 * `reportedAtIso` / `completedAtIso` are ISO strings — either a bare
 * `YYYY-MM-DD` (already AWST) or a full UTC timestamp; both are normalised to
 * their AWST calendar date. `completedAtIso` is null for a row whose rebooked
 * booking has not reached Completed. `rebookedCompleted` is the denominator
 * gate (true once the rebooked booking is Completed).
 */
export interface RectRow {
  reportedAtIso: string
  completedAtIso: string | null
  rebookedCompleted: boolean
}

export interface RectSlaResult {
  /** Rectifications completed within ≤ 2 working days. */
  numerator: number
  /** Completed rectifications (the recoverable, measurable set). */
  denominator: number
  /** On-time percentage, one decimal place; null when denominator is 0. */
  pct: number | null
}

/**
 * Computes the rectification-within-2-working-days SLA over a set of rows.
 *
 * @param rows      NCN/NP rectification rows
 * @param holidays  WA public holiday dates (`YYYY-MM-DD`); passed in, never fetched
 */
export function computeRectSla(
  rows: readonly RectRow[],
  holidays: Iterable<string>,
): RectSlaResult {
  const holidaySet = holidays instanceof Set ? holidays : new Set(holidays)

  let numerator = 0
  let denominator = 0

  for (const row of rows) {
    // Only completed rectifications count — in-flight rows are pending.
    if (!row.rebookedCompleted) continue
    denominator += 1

    if (isWithinTarget(row.reportedAtIso, row.completedAtIso, holidaySet)) {
      numerator += 1
    }
  }

  return {
    numerator,
    denominator,
    pct: denominator === 0 ? null : roundOneDp((numerator / denominator) * 100),
  }
}

/**
 * True when the rectification was completed within the target working days.
 *
 * Returns false for any anomaly that can't be a legitimate on-time completion:
 * a missing/unparseable timestamp, or a completion AWST date strictly before
 * the reported AWST date (negative span — `workingDaysBetween` collapses that to
 * 0, which would otherwise read as an instant pass).
 */
function isWithinTarget(
  reportedAtIso: string,
  completedAtIso: string | null,
  holidays: Set<string>,
): boolean {
  if (completedAtIso === null) return false

  const reportedDate = toAwstDate(reportedAtIso)
  const completedDate = toAwstDate(completedAtIso)
  if (reportedDate === null || completedDate === null) return false

  // Completion before issue is a data anomaly, never an on-time pass.
  if (completedDate < reportedDate) return false

  return workingDaysBetween(reportedDate, completedDate, holidays) <= RECT_TARGET_WD
}

/** Normalises an ISO date/datetime to its AWST `YYYY-MM-DD`; null if unparseable. */
function toAwstDate(iso: string): string | null {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return null
  return awstDateFromUtc(parsed)
}

/** Rounds to one decimal place. */
function roundOneDp(value: number): number {
  return Math.round(value * 10) / 10
}
