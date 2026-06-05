'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'
import { getStatusStyle } from '@/lib/ui/status-styles'
import Link from 'next/link'
import { SkeletonRow } from '@/components/ui/skeleton'
import type { Database } from '@/lib/supabase/types'

type NcnReason = Database['public']['Enums']['ncn_reason']

const STATUS_OPTIONS: string[] = ['Issued', 'Disputed', 'Under Review', 'Resolved', 'Rescheduled', 'Closed']

const PAGE_SIZE = 20

interface NonConformanceClientProps {
  clientId: string
}

export function NonConformanceClient({ clientId }: NonConformanceClientProps) {
  const supabase = createClient()

  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
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
           booking:booking_id(id, ref, status, location,
             eligible_properties:property_id(formatted_address, address),
             collection_area!inner(code)),
           reporter:profiles!non_conformance_notice_reported_by_fkey(display_name)`,
          { count: 'exact' }
        )
        .order('reported_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (clientId) query = query.eq('client_id', clientId)
      if (statusFilter) query = query.eq('status', statusFilter as never)
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
  const totalPages = Math.ceil(total / PAGE_SIZE)

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

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Non-Conformance Notices
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            {total} notices
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2.5 px-7 py-4">
        <div className="flex w-60 items-center gap-2 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0) }}
            placeholder="Search notes, reason..."
            aria-label="Search non-conformance notices"
            className="w-full border-none bg-transparent text-body-sm text-gray-900 outline-none placeholder:text-gray-300"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
          aria-label="Filter by status"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          value={reasonFilter}
          onChange={(e) => { setReasonFilter(e.target.value); setPage(0) }}
          aria-label="Filter by reason"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All Reasons</option>
          {(reasonOptions ?? []).map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        <div className="flex-1" />
        <span className="text-xs text-gray-500">
          Showing {total > 0 ? page * PAGE_SIZE + 1 : 0}&ndash;{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Booking</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Address</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Area</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Reason</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Photos</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Status</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Reported</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Reported By</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={9} />
              ))}
              {!isLoading && notices.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-sm text-gray-400">No non-conformance notices found</td></tr>
              )}
              {notices.map((ncn) => {
                const bookingInfo = getBookingRef(ncn)
                const ss = getStatusStyle('ncn', ncn.status)
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
                    <td className="max-w-[180px] truncate px-4 py-3 text-body-sm">
                      {getAddress(ncn)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {getAreaCode(ncn)}
                    </td>
                    <td className="max-w-[160px] truncate px-4 py-3 text-xs">
                      {ncn.reason}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {ncn.photos.length > 0 ? `${ncn.photos.length} photo${ncn.photos.length > 1 ? 's' : ''}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${ss.bg} ${ss.text}`}>
                        {ncn.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {format(new Date(ncn.reported_at), 'd MMM yyyy')}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {reporter?.display_name ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/non-conformance/${ncn.id}`}
                        className="inline-flex items-center rounded-md border-[1.5px] border-gray-100 bg-white px-3 py-1 text-xs font-semibold text-[#293F52]"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2">
            <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="rounded-md border border-gray-100 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40">Previous</button>
            <span className="text-xs text-gray-500">Page {page + 1} of {totalPages}</span>
            <button type="button" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="rounded-md border border-gray-100 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40">Next</button>
          </div>
        )}
      </div>
    </>
  )
}
