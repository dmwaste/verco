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
 * Filters bookings whose earliest collection_date is on or before targetDate.
 * Returns IDs. Bookings with zero valid dates are skipped — callers that need
 * visibility on that case should inspect inputs separately.
 *
 * <= (not ===) so stragglers transition: a booking confirmed AFTER the daily
 * 15:25 tick for tomorrow (e.g. an NCN/NP rebook created that evening, which
 * lands directly in Confirmed) is caught on the next tick instead of sitting
 * Confirmed forever —
 * which matters because the collection_stop rollup only completes bookings
 * that reached Scheduled.
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
    if (earliest <= targetDate) ids.push(booking.id)
  }
  return ids
}

/**
 * Page size for the Confirmed-booking fetch.
 *
 * Deliberately BELOW Supabase's db-max-rows (1000 on this project). PostgREST
 * silently truncates any response above that cap, and a truncated page is
 * indistinguishable from an exhausted one — so a page size AT the cap would
 * make "short page" ambiguous and could stop paging early. Staying under it
 * keeps "fewer rows than asked for" an unambiguous end-of-set signal.
 */
export const CONFIRMED_PAGE_SIZE = 500

export interface BookingPage<T = BookingWithItemDates> {
  rows: T[]
  error?: string
}

/** Fetches one inclusive [from, to] slice of Confirmed bookings, stably ordered. */
export type FetchBookingPage<T = BookingWithItemDates> = (
  from: number,
  to: number,
) => Promise<BookingPage<T>>

export type FetchAllResult<T = BookingWithItemDates> =
  | { ok: true; rows: T[] }
  | { ok: false; error: string }

/**
 * Pages through every Confirmed booking.
 *
 * Why this exists: the cron used to fetch all Confirmed bookings in ONE
 * unpaginated call. Once the Confirmed set passed 1,000 rows, PostgREST
 * capped the response and the surplus bookings became invisible — they never
 * transitioned to Scheduled, so the field crew could not close them out
 * (Completed/NCN/NP are only reachable FROM Scheduled). It failed silently:
 * the cron still reported failed:0 and HTTP 200, because nothing counts rows
 * it never received. On 24/08/2026 that stranded KWN-2-B2IX82 and
 * KWN-2-XZSK8X out of 1,172 Confirmed bookings. send-collection-reminders
 * shared the same fetch shape, silently skipping reminders for the same slice.
 *
 * The caller MUST apply a stable `.order()` inside fetchPage — unordered
 * `.range()` paging overlaps and skips rows while still returning a
 * plausible-looking total.
 *
 * Returns an error rather than a partial set: a short read here would
 * reproduce the exact bug this function exists to prevent.
 */
export async function fetchAllConfirmedBookings<T = BookingWithItemDates>(
  fetchPage: FetchBookingPage<T>,
  pageSize: number = CONFIRMED_PAGE_SIZE,
): Promise<FetchAllResult<T>> {
  const rows: T[] = []

  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1)
    if (page.error) return { ok: false, error: page.error }

    rows.push(...page.rows)
    if (page.rows.length < pageSize) break
  }

  return { ok: true, rows }
}
