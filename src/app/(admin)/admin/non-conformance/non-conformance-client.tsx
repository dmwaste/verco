'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'
import Link from 'next/link'
import { SkeletonRow } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/status-badge'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'
import { Th } from '@/components/admin/th'
import { Pagination } from '@/components/admin/pagination'
import { OpenInvestigationButton } from '@/components/admin/open-investigation-button'
import { OPEN_EXCEPTION_FILTER_STATUSES, OPENABLE_STATUSES } from '@/lib/exceptions/status'
import { serviceLabelFromSummary } from '@/lib/stops/service-label'
import type { WasteStream } from '@/lib/stops/stops'
import type { Database, Json } from '@/lib/supabase/types'

type NcnReason = Database['public']['Enums']['ncn_reason']

const STATUS_OPTIONS: string[] = ['Issued', 'Disputed', 'Under Review', 'Resolved', 'Rescheduled', 'Closed']

const PAGE_SIZE = 20

interface NonConformanceClientProps {
  clientId: string
}

export function NonConformanceClient({ clientId }: NonConformanceClientProps) {
  const supabase = createClient()

  const [page, setPage] = useState(0)
  // Default to the open (unresolved) set — not "All" — so the queue matches the
  // badge's intent. 'all' shows history; a specific state filters to it.
  const [statusFilter, setStatusFilter] = useState('open')
  const [reasonFilter, setReasonFilter] = useState('')
  const [search, setSearch] = useState('')

  const { data: reasonOptions } = useQuery({
    queryKey: ['ncn-reasons'],
    queryFn: async () => {
      const { data } = await supabase
        .from('non_conformance_notice')
        .select('reason')
      const unique = [...new Set((data ?? []).map((r) => r.reason))]
      return unique.sort()
    },
  })

  const { data: ncnData, isLoading } = useQuery({
    queryKey: ['admin-ncn', clientId, statusFilter, reasonFilter, search, page],
    queryFn: async () => {
      let query = supabase
        .from('non_conformance_notice')
        .select(
          `id, reason, status, notes, photos, reported_at, resolved_at,
           collection_stop:collection_stop_id(stream, services_summary),
           booking:booking_id(id, ref, status, location,
             eligible_properties:property_id(formatted_address, address),
             collection_area!inner(code)),
           reporter:profiles!non_conformance_notice_reported_by_fkey(display_name)`,
          { count: 'exact' }
        )
        .order('reported_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (clientId) query = query.eq('client_id', clientId)
      // Records are the source of truth — never filter by booking.status (a
      // notice on a still-Scheduled booking is a legitimate exception).
      if (statusFilter === 'open') query = query.in('status', [...OPEN_EXCEPTION_FILTER_STATUSES])
      else if (statusFilter !== 'all' && statusFilter) query = query.eq('status', statusFilter as never)
      if (reasonFilter) query = query.eq('reason', reasonFilter as NcnReason)
      if (search) {
        query = query.or(buildSearchOrFilter(['notes', 'reason'], search))
      }

      const { data, count } = await query
      return { notices: data ?? [], total: count ?? 0 }
    },
  })

  const notices = ncnData?.notices ?? []
  const total = ncnData?.total ?? 0

  function getAddress(notice: (typeof notices)[number]): string {
    const booking = notice.booking as unknown as {
      eligible_properties: { formatted_address: string | null; address: string } | null
    } | null
    if (!booking?.eligible_properties) return '—'
    return booking.eligible_properties.formatted_address ?? booking.eligible_properties.address
  }

  function getBookingRef(notice: (typeof notices)[number]): { ref: string; id: string } | null {
    const booking = notice.booking as unknown as { id: string; ref: string } | null
    if (!booking) return null
    return { ref: booking.ref, id: booking.id }
  }

  function getAreaCode(notice: (typeof notices)[number]): string {
    const booking = notice.booking as unknown as { collection_area: { code: string } } | null
    return booking?.collection_area?.code ?? '—'
  }

  function getServiceType(notice: (typeof notices)[number]): string {
    const stop = notice.collection_stop as unknown as {
      stream: WasteStream
      services_summary: Json
    } | null
    if (!stop) return '—'
    return serviceLabelFromSummary(stop.services_summary, stop.stream).label
  }

  function getBookingStatus(notice: (typeof notices)[number]): string {
    const booking = notice.booking as unknown as { status: string } | null
    return booking?.status ?? '—'
  }

  return (
    <>
      <PageHeader title="Non-Conformance Notices" subtitle={`${total} notices`} />

      {/* Filters */}
      <FilterBar>
        <SearchInput
          value={search}
          onChange={(value) => { setSearch(value); setPage(0) }}
          placeholder="Search notes, reason..."
          ariaLabel="Search non-conformance notices"
        />

        <FilterSelect
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
          aria-label="Filter by status"
        >
          <option value="open">Open</option>
          <option value="all">All Statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </FilterSelect>

        <FilterSelect
          value={reasonFilter}
          onChange={(e) => { setReasonFilter(e.target.value); setPage(0) }}
          aria-label="Filter by reason"
        >
          <option value="">All Reasons</option>
          {(reasonOptions ?? []).map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </FilterSelect>
      </FilterBar>

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th>Booking</Th>
                <Th>Booking Status</Th>
                <Th>Address</Th>
                <Th>Area</Th>
                <Th>Service type</Th>
                <Th>Reason</Th>
                <Th>Photos</Th>
                <Th>Status</Th>
                <Th>Reported</Th>
                <Th>Reported By</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={11} />
              ))}
              {!isLoading && notices.length === 0 && (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-sm text-gray-400">No non-conformance notices found</td></tr>
              )}
              {notices.map((ncn) => {
                const bookingInfo = getBookingRef(ncn)
                const reporter = ncn.reporter as { display_name: string | null } | null
                return (
                  <tr key={ncn.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      {bookingInfo ? (
                        <Link
                          href={`/admin/bookings/${bookingInfo.id}`}
                          className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52] hover:underline"
                        >
                          {bookingInfo.ref}
                        </Link>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {getBookingStatus(ncn)}
                    </td>
                    <td className="max-w-[180px] truncate px-4 py-3 text-body-sm">
                      {getAddress(ncn)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {getAreaCode(ncn)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {getServiceType(ncn)}
                    </td>
                    <td className="max-w-[160px] truncate px-4 py-3 text-xs">
                      {ncn.reason}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {ncn.photos.length > 0 ? `${ncn.photos.length} photo${ncn.photos.length > 1 ? 's' : ''}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge entity="ncn" status={ncn.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {format(new Date(ncn.reported_at), 'd MMM yyyy')}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {reporter?.display_name ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {(OPENABLE_STATUSES as readonly string[]).includes(ncn.status) && (
                          <OpenInvestigationButton kind="ncn" noticeId={ncn.id} />
                        )}
                        <Link
                          href={`/admin/non-conformance/${ncn.id}`}
                          className="inline-flex items-center rounded-md border-[1.5px] border-gray-100 bg-white px-3 py-1 text-xs font-semibold text-[#293F52]"
                        >
                          View
                        </Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      </div>
    </>
  )
}
