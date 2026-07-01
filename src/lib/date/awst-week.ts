import { awstDateFromUtc } from '@/lib/booking/schedule-transition'

/** Returns the YYYY-MM-DD that is `delta` days from `yyyymmdd` (UTC-based, DST-free). */
function shiftDays(yyyymmdd: string, delta: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/**
 * The Monday–Sunday AWST week containing `now`, as YYYY-MM-DD date strings.
 *
 * Built on the fixed AWST offset (UTC+8, no DST) via `awstDateFromUtc`, so the
 * window is **independent of the runtime timezone** — the prod container runs
 * UTC, where `date-fns` `startOfWeek(new Date())` computes the *UTC* week and can
 * land a day off for an AWST-evening instant. Used to scope the "this week"
 * dashboard widgets to collections whose `collection_date` (a calendar date in
 * AWST) falls in the current AWST week. Mirrors the TZ discipline in
 * `cancellation-cutoff.ts`.
 */
export function awstWeekRange(now: Date): { monday: string; sunday: string } {
  const today = awstDateFromUtc(now)
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay() // 0=Sun … 6=Sat
  const daysFromMonday = (dow + 6) % 7
  const monday = shiftDays(today, -daysFromMonday)
  return { monday, sunday: shiftDays(monday, 6) }
}
