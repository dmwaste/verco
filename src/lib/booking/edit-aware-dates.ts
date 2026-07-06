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
 * date to `closed`. Admin-closed/holiday held dates (`is_open=false`) never
 * reach here — RLS `USING(is_open=true)` hides them from the anon read.
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
