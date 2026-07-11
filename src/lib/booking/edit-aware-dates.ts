import {
  effectiveCapacity,
  type CollectionDateCapacity,
  type CollectionDatePoolCapacity,
} from '@/lib/capacity/effective-capacity'
import type { DateStatus } from '@/lib/booking/calendar'

/** A `collection_date` row plus its id — the shape the Date step fetches. */
export type CollectionDateRow = CollectionDateCapacity & { id: string }

/** One calendar cell: id, its Date, and the availability token to render. */
export interface CalendarDateCell {
  id: string
  date: Date
  status: DateStatus
}

/**
 * Build the calendar cells for the booking Date step.
 *
 * New-booking behaviour: dates whose needed capacity bucket is closed are
 * filtered out; the rest get an available/low/closed token from remaining bulk
 * headroom.
 *
 * Edit behaviour (`heldDateId` set, only when the wizard carries `replaces`):
 * the resident's already-held date is ALWAYS kept — never capacity-filtered —
 * and rendered with the neutral `current` token, so a services edit can retain
 * a date that has since gone capacity-full or T-3-locked. The `current` status
 * is hard-set and bypasses the `spotsRemaining` derivation, so pooled areas
 * (whose `collection_date.*` counters are 0 by design) don't collapse the held
 * date to `closed`.
 *
 * Admin-closed/holiday held dates (`is_open=false`) and PAST held dates are
 * dropped by the resident date fetch (`is_open=true AND date>=today`), so the
 * held row never reaches `dates` for residents. For a contractor-tier actor the
 * caller fetches that row separately (RLS `collection_date_select` permits the
 * authed read) and merges it in via `mergeHeldDate` before calling this — the
 * `d.id === heldDateId` pin below then keeps it as `current`. Client-tier admins
 * and residents never get that merge, so they still can't keep a closed/past
 * held date here (#378).
 */
export function buildCalendarDates(params: {
  dates: CollectionDateRow[]
  poolId: string | null
  poolByDate: Map<string, CollectionDatePoolCapacity>
  neededBuckets: Set<string> | undefined
  heldDateId?: string | null
}): CalendarDateCell[] {
  const { dates, poolId, poolByDate, neededBuckets, heldDateId = null } = params

  return dates
    .filter((d) => {
      if (d.id === heldDateId) return true
      if (!neededBuckets) return true
      const cap = effectiveCapacity(d, poolId, poolByDate)
      if (neededBuckets.has('bulk') && cap.bulk_is_closed) return false
      if (neededBuckets.has('anc') && cap.anc_is_closed) return false
      return true
    })
    .map((d) => {
      const date = new Date(d.date + 'T00:00:00')
      if (d.id === heldDateId) {
        return { id: d.id, date, status: 'current' as DateStatus }
      }
      const cap = effectiveCapacity(d, poolId, poolByDate)
      const spotsRemaining = Math.max(
        0,
        cap.bulk_capacity_limit - cap.bulk_units_booked,
      )
      const status: DateStatus =
        spotsRemaining === 0 ? 'closed' : spotsRemaining <= 10 ? 'low' : 'available'
      return { id: d.id, date, status }
    })
}

/**
 * Merge a separately-fetched held-date row into the wizard's fetched date list,
 * keeping the list sorted by date (ISO `yyyy-mm-dd` string order is
 * chronological). No-op when there is no held row or it is already present.
 *
 * Used only on the contractor-tier edit path: the resident date fetch filters
 * `is_open=true AND date>=today`, so a booking's own held date that has since
 * gone admin-closed or past is missing from `dates`. The caller fetches that one
 * row by id (authorised by RLS `collection_date_select`) and merges it here so
 * `buildCalendarDates` can pin it as `current` — letting D&M staff KEEP the held
 * date instead of being forced onto a different one (#378). Client-tier admins
 * and residents never fetch the row, so they never receive the merge.
 */
export function mergeHeldDate(
  dates: CollectionDateRow[],
  heldRow: CollectionDateRow | null | undefined,
): CollectionDateRow[] {
  if (!heldRow) return dates
  if (dates.some((d) => d.id === heldRow.id)) return dates
  return [...dates, heldRow].sort((a, b) => a.date.localeCompare(b.date))
}
