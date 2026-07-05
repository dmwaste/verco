'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'
import { photoCount } from '@/lib/booking/id-photos'
import { SkeletonRow } from '@/components/ui/skeleton'
import { Th } from '@/components/admin/th'
import { Pagination } from '@/components/admin/pagination'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect, DateRangeFilter } from '@/components/admin/filter-bar'
import { StatusBadge } from '@/components/status-badge'

const PAGE_SIZE = 50

// Booking statuses that an ID booking can hold. Same state machine as
// regular bookings (CLAUDE.md §7) — rangers create as 'Submitted'.
const BOOKING_STATUSES = [
  'Submitted',
  'Confirmed',
  'Scheduled',
  'Completed',
  'Cancelled',
  'Non-conformance',
  'Nothing Presented',
] as const

interface IllegalDumpingClientProps {
  clientId: string
  // Reserved for contractor-only actions in a future iteration (e.g. bulk
  // close, export). Currently unused at MVP scope.
  isContractorAdmin: boolean
}


export function IllegalDumpingClient({ clientId }: IllegalDumpingClientProps) {
  const supabase = createClient()

  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [areaFilter, setAreaFilter] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  // Collection-date range (booking_item.collection_date.date), YYYY-MM-DD or ''.
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function handleSearchChange(value: string) {
    setSearch(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(value)
      setPage(0)
    }, 300)
  }

  // Tenant areas — explicit client_id filter required (public-SELECT RLS).
  const { data: areas } = useQuery({
    queryKey: ['id-areas', clientId],
    queryFn: async () => {
      let query = supabase
        .from('collection_area')
        .select('id, code, name')
        .eq('is_active', true)
        .order('code')
      if (clientId) {
        query = query.eq('client_id', clientId)
      }
      const { data } = await query
      return data ?? []
    },
  })

  // ID bookings: type='Illegal Dumping' + tenant scope via collection_area
  // inner join. booking_item carries the collection_date_id, so embed
  // booking_item(collection_date(...)) for the scheduled date column.
  const { data: idData, isLoading } = useQuery({
    queryKey: ['admin-illegal-dumping', statusFilter, areaFilter, debouncedSearch, dateFrom, dateTo, page, clientId],
    queryFn: async () => {
      // Collection-date range filters the parent, so booking_item→collection_date
      // must be inner-joined when a bound is set (a LEFT embed can't filter
      // parents — §21). No date filter → keep LEFT so undated IDs still show.
      const dateFilterActive = !!(dateFrom || dateTo)
      const itemsEmbed = dateFilterActive
        ? 'booking_item!inner(collection_date!inner(id, date, id_capacity_limit, id_units_booked))'
        : 'booking_item(collection_date(id, date, id_capacity_limit, id_units_booked))'

      let query = supabase
        .from('booking')
        .select(
          `id, ref, status, latitude, longitude, geo_address, notes, photos, created_at,
           collection_area_id,
           collection_area!inner(code, name, client_id),
           ${itemsEmbed}`,
          { count: 'exact' }
        )
        .eq('type', 'Illegal Dumping')
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (statusFilter) {
        query = query.eq('status', statusFilter as never)
      }
      if (areaFilter) {
        query = query.eq('collection_area_id', areaFilter)
      }
      if (dateFrom) query = query.gte('booking_item.collection_date.date', dateFrom)
      if (dateTo) query = query.lte('booking_item.collection_date.date', dateTo)
      if (debouncedSearch) {
        query = query.or(
          buildSearchOrFilter(['ref', 'geo_address', 'notes'], debouncedSearch)
        )
      }
      if (clientId) {
        query = query.eq('collection_area.client_id', clientId)
      }

      const { data, count } = await query
      return { bookings: data ?? [], total: count ?? 0 }
    },
  })

  const bookings = idData?.bookings ?? []
  const total = idData?.total ?? 0

  // Status counts for the strip — one query covering all statuses.
  const { data: statusCounts } = useQuery({
    queryKey: ['id-status-counts', clientId],
    queryFn: async () => {
      let query = supabase
        .from('booking')
        .select('status, collection_area!inner(client_id)')
        .eq('type', 'Illegal Dumping')
      if (clientId) {
        query = query.eq('collection_area.client_id', clientId)
      }
      const { data } = await query
      const counts: Record<string, number> = {}
      for (const row of data ?? []) {
        const key = row.status ?? 'Unknown'
        counts[key] = (counts[key] ?? 0) + 1
      }
      return counts
    },
  })

  const summaryPills: Array<{ key: string; label: string; color: string }> = [
    { key: 'Submitted', label: 'Submitted', color: 'text-amber-600 border-amber-200 bg-amber-50' },
    { key: 'Confirmed', label: 'Confirmed', color: 'text-blue-600 border-blue-200 bg-blue-50' },
    { key: 'Scheduled', label: 'Scheduled', color: 'text-indigo-600 border-indigo-200 bg-indigo-50' },
    { key: 'Completed', label: 'Completed', color: 'text-emerald-600 border-emerald-200 bg-emerald-50' },
  ]

  return (
    <>
      {/* Header */}
      <PageHeader
        title="Illegal Dumping"
        subtitle={`${total} ID collection${total !== 1 ? 's' : ''} — raised by rangers in the field and office staff.`}
      >
        <Link
          href="/admin/illegal-dumping/new"
          className="flex items-center gap-1.5 rounded-lg bg-[#293F52] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1e3040]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New ID Collection
        </Link>
      </PageHeader>

      {/* Status summary strip */}
      <div className="mx-7 mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {summaryPills.map((pill) => (
          <button
            key={pill.key}
            type="button"
            onClick={() => { setStatusFilter(statusFilter === pill.key ? '' : pill.key); setPage(0) }}
            className={`rounded-xl border px-4 py-3 text-left transition-colors ${pill.color} ${statusFilter === pill.key ? 'ring-2 ring-[#293F52]' : ''}`}
          >
            <div className="text-caption font-semibold uppercase tracking-wide">{pill.label}</div>
            <div className="mt-1 text-xl font-bold">{statusCounts?.[pill.key] ?? 0}</div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <FilterBar>
        <SearchInput
          value={search}
          onChange={handleSearchChange}
          placeholder="Search ref, address, notes..."
          ariaLabel="Search illegal dumping reports"
        />

        <FilterSelect
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
          aria-label="Filter by status"
        >
          <option value="">All Statuses</option>
          {BOOKING_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </FilterSelect>

        <FilterSelect
          value={areaFilter}
          onChange={(e) => { setAreaFilter(e.target.value); setPage(0) }}
          aria-label="Filter by area"
        >
          <option value="">All Areas</option>
          {(areas ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
          ))}
        </FilterSelect>

        <DateRangeFilter
          label="Collection"
          from={dateFrom}
          to={dateTo}
          onChange={(from, to) => { setDateFrom(from); setDateTo(to); setPage(0) }}
          ariaPrefix="Collection date"
        />
      </FilterBar>

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th>Ref</Th>
                <Th>Location</Th>
                <Th>Area</Th>
                <Th>Collection Date</Th>
                <Th>Capacity</Th>
                <Th>Photos</Th>
                <Th>Status</Th>
                <Th>Reported</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={9} />
              ))}
              {!isLoading && bookings.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-sm text-gray-400">No illegal dumping reports found</td></tr>
              )}
              {bookings.map((b) => {
                const area = b.collection_area as { code: string; name: string }
                const items = (b.booking_item as Array<{
                  collection_date: { date: string; id_capacity_limit: number; id_units_booked: number } | null
                }> | null) ?? []
                const collDate = items[0]?.collection_date ?? null
                const nPhotos = photoCount(b.photos, b.notes)
                return (
                  <tr key={b.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/bookings/${b.id}`}
                        className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52] hover:underline"
                      >
                        {b.ref}
                      </Link>
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-body-sm text-gray-700">
                      {b.geo_address ?? (
                        b.latitude != null && b.longitude != null
                          ? `${Number(b.latitude).toFixed(5)}, ${Number(b.longitude).toFixed(5)}`
                          : '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{area.code}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {collDate ? format(new Date(collDate.date), 'd MMM yyyy') : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {collDate
                        ? `${collDate.id_units_booked} / ${collDate.id_capacity_limit}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {nPhotos > 0
                        ? <span className="rounded-full bg-gray-100 px-2 py-0.5 font-semibold text-gray-700">{nPhotos}</span>
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge entity="booking" status={b.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {format(new Date(b.created_at), 'd MMM yyyy')}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/bookings/${b.id}`}
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
