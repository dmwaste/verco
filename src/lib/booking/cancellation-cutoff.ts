/**
 * Cancellation cutoff (CLAUDE.md §7): 3:30pm AWST the day before collection.
 *
 * WA has no daylight saving, so a fixed +08:00 offset is exact: 3:30pm AWST is
 * 07:30 UTC. Computing the instant via `Date.UTC` keeps it **independent of the
 * runtime timezone** — the prod container runs UTC, where the previous
 * `Date#setHours(15, 30)` math landed the cutoff hours off and wrongly blocked
 * residents from cancelling valid bookings. This matches the DB trigger
 * `enforce_cancellation_cutoff` exactly:
 *   (collection_date - interval '1 day')::timestamptz + interval '7 hours 30 minutes'
 */
export function cancellationCutoff(collectionDateStr: string): Date {
  const [y, m, d] = collectionDateStr.split('-').map(Number)
  // Day before collection at 07:30:00 UTC. Date.UTC normalises month/day rollover.
  return new Date(Date.UTC(y, m - 1, d - 1, 7, 30, 0, 0))
}

/** True once `now` has reached the 3:30pm-AWST-day-before cutoff. */
export function isPastCancellationCutoff(
  collectionDateStr: string,
  now: Date
): boolean {
  return now.getTime() >= cancellationCutoff(collectionDateStr).getTime()
}
