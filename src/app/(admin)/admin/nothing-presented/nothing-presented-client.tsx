'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { SkeletonRow } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/status-badge'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'
import { Th } from '@/components/admin/th'
import { Pagination } from '@/components/admin/pagination'

const STATUS_OPTIONS: string[] = ['Issued', 'Disputed', 'Under Review', 'Resolved', 'Rebooked', 'Closed']

const PAGE_SIZE = 20

interface NothingPresentedClientProps {
  clientId: string
}

export function NothingPresentedClient({ clientId }: NothingPresentedClientProps) {
  const supabase = createClient()

  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [faultFilter, setFaultFilter] = useState('')
  const [search, setSearch] = useState('')

  const { data: npData, isLoading } = useQuery({
    queryKey: ['admin-np', clientId, statusFilter, faultFilter, search, page],
    queryFn: async () => {
      let query = supabase
        .from('nothing_presented')
        .select(
          `id, status, contractor_fault, notes, photos, reported_at, resolved_at,
           booking:booking_id(id, ref, status, location,
             eligible_properties:property_id(formatted_address, address),
             collection_area!inner(code)),
           reporter:profiles!nothing_presented_reported_by_fkey(display_name)`,
          { count: 'exact' }
        )
        .order('reported_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (clientId) query = query.eq('client_id', clientId)
      if (statusFilter) query = query.eq('status', statusFilter as never)
      if (faultFilter === 'dm') query = query.eq('contractor_fault', true)
      if (faultFilter === 'resident') query = query.eq('contractor_fault', false)
      if (search) {
        query = query.ilike('notes', `%${search}%`)
      }

      const { data, count } = await query
      return { records: data ?? [], total: count ?? 0 }
    },
  })

  const records = npData?.records ?? []
  const total = npData?.total ?? 0

  function getAddress(record: (typeof records)[number]): string {
    const booking = record.booking as unknown as {
      eligible_properties: { formatted_address: string | null; address: string } | null
    } | null
    if (!booking?.eligible_properties) return '—'
    return booking.eligible_properties.formatted_address ?? booking.eligible_properties.address
  }

  function getBookingRef(record: (typeof records)[number]): { ref: string; id: string } | null {
    const booking = record.booking as unknown as { id: string; ref: string } | null
    if (!booking) return null
    return { ref: booking.ref, id: booking.id }
  }

  function getAreaCode(record: (typeof records)[number]): string {
    const booking = record.booking as unknown as { collection_area: { code: string } } | null
    return booking?.collection_area?.code ?? '—'
  }

  return (
    <>
      <PageHeader title="Nothing Presented" subtitle={`${total} records`} />

      {/* Filters */}
      <FilterBar>
        <SearchInput
          value={search}
          onChange={(value) => { setSearch(value); setPage(0) }}
          placeholder="Search notes..."
          ariaLabel="Search nothing presented records"
        />

        <FilterSelect
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
          aria-label="Filter by status"
        >
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </FilterSelect>

        <FilterSelect
          value={faultFilter}
          onChange={(e) => { setFaultFilter(e.target.value); setPage(0) }}
          aria-label="Filter by fault type"
        >
          <option value="">All Fault Types</option>
          <option value="dm">Contractor Fault</option>
          <option value="resident">Resident Fault</option>
        </FilterSelect>
      </FilterBar>

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th>Booking</Th>
                <Th>Address</Th>
                <Th>Area</Th>
                <Th>Fault</Th>
                <Th>Photos</Th>
                <Th>Status</Th>
                <Th>Reported</Th>
                <Th>Reported By</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={9} />
              ))}
              {!isLoading && records.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-sm text-gray-400">No nothing presented records found</td></tr>
              )}
              {records.map((np) => {
                const bookingInfo = getBookingRef(np)
                const reporter = np.reporter as { display_name: string | null } | null
                return (
                  <tr key={np.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
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
                      {getAddress(np)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {getAreaCode(np)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-caption font-semibold ${np.contractor_fault ? 'bg-status-error-bg text-status-error' : 'bg-gray-100 text-gray-600'}`}>
                        {np.contractor_fault ? 'Contractor' : 'Resident'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {np.photos.length > 0 ? `${np.photos.length} photo${np.photos.length > 1 ? 's' : ''}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge entity="np" status={np.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {format(new Date(np.reported_at), 'd MMM yyyy')}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {reporter?.display_name ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/nothing-presented/${np.id}`}
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

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      </div>
    </>
  )
}
