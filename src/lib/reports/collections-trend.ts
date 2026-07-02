/**
 * Collections trend — collections per month (VER-294, B1 delta card).
 *
 * Pure mirror of the `get_collections_trend` SECURITY DEFINER RPC so the
 * bucketing arithmetic is DB-independent + unit-testable to 100% (CLAUDE.md
 * §14). No Supabase, no network, no wall-clock.
 *
 * A "collection" is a booking that reached the field (the dashboard's
 * established BC status set: Completed / Non-conformance / Nothing Presented /
 * Scheduled / Missed Collection — the CALLER filters statuses, exactly as the
 * clean-collection fn receives pre-scoped sets). Each booking counts ONCE, in
 * the month of its service date = the MIN `collection_date.date` across its
 * booking_items (schema allows per-item dates; real carts share one).
 *
 * Months with zero collections BETWEEN the first and last observed month are
 * gap-filled with 0 so the card renders a continuous axis. The series is NOT
 * extended to the current wall-clock month (no wall-clock reads here — that,
 * and the go-live-cliff label, are render concerns for the card).
 */

/** One booking_item row: the booking it belongs to + its collection date. */
export interface CollectionsTrendRow {
  bookingId: string
  /** `YYYY-MM-DD` collection date (a plain AWST calendar date in the DB). */
  collectionDateIso: string
}

export interface CollectionsTrendBucket {
  /** Calendar month, `YYYY-MM`. */
  month: string
  /** Distinct bookings whose service date falls in this month. */
  collections: number
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Buckets bookings into monthly collection counts, gap-filled min→max month.
 *
 * Rows with a malformed date are skipped (the RPC's `date` column can never
 * produce one — this guards the pure path only). Returns [] for no input.
 */
export function computeCollectionsTrend(
  rows: readonly CollectionsTrendRow[],
): CollectionsTrendBucket[] {
  // Service date per booking = MIN item date (string compare is safe for
  // zero-padded YYYY-MM-DD).
  const serviceDateByBooking = new Map<string, string>()
  for (const row of rows) {
    if (!DATE_RE.test(row.collectionDateIso)) continue
    const current = serviceDateByBooking.get(row.bookingId)
    if (current === undefined || row.collectionDateIso < current) {
      serviceDateByBooking.set(row.bookingId, row.collectionDateIso)
    }
  }
  if (serviceDateByBooking.size === 0) return []

  const countByMonth = new Map<string, number>()
  for (const serviceDate of serviceDateByBooking.values()) {
    const month = serviceDate.slice(0, 7)
    countByMonth.set(month, (countByMonth.get(month) ?? 0) + 1)
  }

  const months = [...countByMonth.keys()].sort()
  const first = months[0]!
  const last = months[months.length - 1]!

  const buckets: CollectionsTrendBucket[] = []
  for (let m = first; m <= last; m = nextMonth(m)) {
    buckets.push({ month: m, collections: countByMonth.get(m) ?? 0 })
  }
  return buckets
}

/** `YYYY-MM` → the following `YYYY-MM`. */
function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const mon = Number(month.slice(5, 7))
  const rolled = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`
  return rolled
}
