/**
 * The 3:00pm cut-off staff work to when they add a job close to collection day.
 *
 * WMRC publishes 3:00pm the day before, and it matches the dispatch reality:
 * the day's work goes to OptimoRoute three days out, and crews take their
 * routes at 8pm the night before. A job added after 3:00pm for tomorrow would
 * reach OptimoRoute on the next hourly push with nobody having told the driver.
 *
 * It only ever bites on a next-day job — for anything further out we are
 * already before it.
 *
 * WA has no daylight saving, so a fixed +08:00 offset is exact: 3:00pm AWST is
 * 07:00 UTC. Computed via `Date.UTC` so it does not depend on the server's
 * timezone — `Date#setHours` is wrong on the UTC production box, which is how
 * the cancellation cut-off got this wrong once (see cancellation-cutoff.ts).
 *
 * The SQL equivalent, for the gates that live in the database:
 *   (now() AT TIME ZONE 'Australia/Perth')
 *     < (collection_date - interval '1 day' + interval '15 hours')
 */

/** 3:00pm AWST on the day before `collectionDate` (`YYYY-MM-DD`), as an instant. */
export function nextDayCutoff(collectionDate: string): Date {
  const [y, m, d] = collectionDate.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d - 1, 7, 0, 0, 0))
}

/** True once the 3:00pm-AWST-day-before cut-off has passed for that date. */
export function isPastNextDayCutoff(
  collectionDate: string,
  now: Date = new Date(),
): boolean {
  return now.getTime() >= nextDayCutoff(collectionDate).getTime()
}
