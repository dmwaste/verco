/**
 * Place-out window arithmetic for the ranger lookup: residents may put their
 * pile on the verge from `place_out_hours_before` hours before midnight AWST
 * on the collection date. A pile sighted inside the window with an upcoming
 * booking is a legitimate booking, not illegal dumping.
 */
export function placeOutStart(collectionDate: string, hoursBefore: number): Date {
  // Collection dates are AWST calendar dates (UTC+8, no DST in WA).
  const midnight = new Date(`${collectionDate}T00:00:00+08:00`)
  return new Date(midnight.getTime() - hoursBefore * 60 * 60 * 1000)
}

export type PlaceOutVerdict = 'open' | 'not-yet' | 'none'

/**
 * Renders a place-out instant in AWST regardless of where the code runs.
 * date-fns `format()` uses the runtime's local timezone — on the prod server
 * (UTC container) that would display the window 8 hours early.
 */
export function formatPlaceOutStart(d: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Perth',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

/**
 * Verdict for "is this pile plausibly a booking?" given the property's next
 * upcoming collection date (or null), the tenant's place-out hours, and now.
 */
export function placeOutVerdict(
  nextCollectionDate: string | null,
  hoursBefore: number,
  now: Date,
): PlaceOutVerdict {
  if (!nextCollectionDate) return 'none'
  return now.getTime() >= placeOutStart(nextCollectionDate, hoursBefore).getTime()
    ? 'open'
    : 'not-yet'
}
