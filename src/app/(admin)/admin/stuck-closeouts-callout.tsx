import Link from 'next/link'
import { DEFAULT_STALE_THRESHOLD_DAYS, worklistUrl } from '@/lib/ops/stale-closeouts'

/**
 * Dashboard entry point to the stale-closeout worklist (#575): Scheduled
 * bookings whose collection date is `DEFAULT_STALE_THRESHOLD_DAYS`+ days past
 * and still not closed out. Opens the same bookings-list filter as the daily
 * Teams alert's "Full backlog" link, so the count and the list agree. Renders
 * nothing when nothing is stuck. Contractor-only — the page decides that.
 */
export function StuckCloseoutsCallout({ count, cutoffDate }: { count: number; cutoffDate: string }) {
  if (count <= 0) return null
  return (
    <Link
      href={worklistUrl('', { dateTo: cutoffDate })}
      className="flex items-center justify-between gap-3 rounded-xl bg-status-warn-bg px-5 py-3 text-body-sm text-status-warn transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#293F52]/40"
    >
      <span>
        <span className="font-semibold">Stuck closeouts ({count})</span>
        {' '}&middot; {count} {count === 1 ? 'booking' : 'bookings'} {DEFAULT_STALE_THRESHOLD_DAYS}+ days past collection, not closed out
      </span>
      <span className="shrink-0 font-medium">View &rarr;</span>
    </Link>
  )
}
