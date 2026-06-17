import { addOneDay, awstDateFromUtc } from '@/lib/booking/schedule-transition'

/**
 * Shared working-days calculator for the SLA dashboard (VER-179).
 *
 * Used by RECT (rectification ≤ 2 working days) and the SR first-response
 * sub-SLA (≤ 3 working days). Pure + deterministic: no Supabase, no network,
 * no wall-clock reads — it compares two stored timestamps passed in.
 *
 * Counts Mon–Fri AWST dates strictly after `start` through `end` (the
 * half-open window `(start, end]`), then subtracts any WA public holiday that
 * falls on a counted weekday inside that same window. A holiday on a weekend is
 * never subtracted (it was never in the weekday count) so the result can never
 * skew below the true working-day total.
 *
 * Inputs are ISO strings — either a bare `YYYY-MM-DD` (already an AWST date,
 * e.g. the output of `awstDateFromUtc`) or a full UTC timestamp. Both are
 * normalised to their AWST calendar date via `awstDateFromUtc`, so a 7:30am
 * AWST closeout (the previous UTC day) buckets to the correct AWST day rather
 * than mis-bucketing under a naive UTC `::date`.
 *
 * @param startIso  window lower bound (exclusive), ISO date or datetime
 * @param endIso    window upper bound (inclusive), ISO date or datetime
 * @param holidays  WA public holiday dates as `YYYY-MM-DD` strings (Iterable);
 *                  passed in, never fetched
 * @returns         working-day count; 0 when `end <= start`
 */
export function workingDaysBetween(
  startIso: string,
  endIso: string,
  holidays: Iterable<string>,
): number {
  const start = awstDateFromUtc(new Date(startIso))
  const end = awstDateFromUtc(new Date(endIso))

  // Reversed or zero-length window → no working days.
  if (end <= start) return 0

  const holidaySet = holidays instanceof Set ? holidays : new Set(holidays)

  let count = 0
  // Iterate over (start, end]: begin at the day after start, include end.
  for (let day = addOneDay(start); day <= end; day = addOneDay(day)) {
    if (!isWeekday(day)) continue // weekend never counts
    if (holidaySet.has(day)) continue // WA holiday on a weekday → excluded
    count += 1
  }
  return count
}

/** True for Mon–Fri. Parses `YYYY-MM-DD` as a UTC instant (no TZ drift). */
function isWeekday(yyyymmdd: string): boolean {
  const dow = new Date(`${yyyymmdd}T00:00:00Z`).getUTCDay()
  return dow >= 1 && dow <= 5
}
