// Transition logic mirrored in src/lib/booking/schedule-transition.ts — keep in sync

/**
 * Pure helpers for the Confirmed → Scheduled daily cron.
 *
 * The cron fires at 15:25 AWST (07:25 UTC) each day. Bookings whose earliest
 * collection date is *tomorrow* AWST transition to Scheduled, because the
 * cancellation cutoff (15:30 AWST the day prior) is about to pass.
 *
 * Using MIN(collection_date.date) matches the enforce_cancellation_cutoff
 * trigger — keep aligned if the cutoff semantics ever change.
 */

export interface BookingWithItemDates {
  id: string
  booking_item: Array<{ collection_date: { date: string } | null }>
}

/**
 * Returns the AWST calendar date (YYYY-MM-DD) for the given UTC instant.
 * AWST is UTC+8 year-round (no DST).
 */
export function awstDateFromUtc(nowUtc: Date): string {
  const awstMs = nowUtc.getTime() + 8 * 60 * 60 * 1000
  return new Date(awstMs).toISOString().slice(0, 10)
}

/** Returns YYYY-MM-DD for the day after the given YYYY-MM-DD string. */
export function addOneDay(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Filters bookings whose earliest collection_date equals targetDate.
 * Returns IDs. Bookings with zero valid dates are skipped — callers that need
 * visibility on that case should inspect inputs separately.
 */
export function filterBookingsReadyToSchedule(
  bookings: BookingWithItemDates[],
  targetDate: string,
): string[] {
  const ids: string[] = []
  for (const booking of bookings) {
    const dates = booking.booking_item
      .map((item) => item.collection_date?.date)
      .filter((d): d is string => Boolean(d))
    if (dates.length === 0) continue
    const earliest = dates.reduce((min, d) => (d < min ? d : min))
    if (earliest === targetDate) ids.push(booking.id)
  }
  return ids
}
