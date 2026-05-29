'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'
import { SkeletonRow } from '@/components/ui/skeleton'
import { getStatusStyle } from '@/lib/ui/status-styles'

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

// Photos are stored in booking.notes as "Photos: N" by the ranger intake
// (field/illegal-dumping/new/actions.ts). MVP shows the count only — raw
// URLs are not yet persisted to a dedicated column. See plan gotcha #1.
const PHOTO_COUNT_RE = /Photos:\s*(\d+)/

function extractPhotoCount(notes: string | null | undefined): number {
  if (!notes) return 0
  const m = notes.match(PHOTO_COUNT_RE)
  return m && m[1] ? parseInt(m[1], 10) : 0
}

export function IllegalDumpingClient({ clientId }: IllegalDumpingClientProps) {
  const supabase = createClient()

  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [areaFilter, setAreaFilter] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

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
    queryKey: ['admin-illegal-dumping', statusFilter, areaFilter, debouncedSearch, page, clientId],
    queryFn: async () => {
      let query = supabase
        .from('booking')
        .select(
          `id, ref, status, latitude, longitude, geo_address, notes, created_at,
           collection_area_id,
           collection_area!inner(code, name, client_id),
           booking_item(collection_date(id, date, id_capacity_limit, id_units_booked))`,
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
  const totalPages = Math.ceil(total / PAGE_SIZE)

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
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Illegal Dumping
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            {total} ID report{total !== 1 ? 's' : ''} — raised by ranger role from the field.
          </p>
        </div>
      </div>

      {/* Status summary strip */}
      <div className="mx-7 mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {summaryPills.map((pill) => (
          <button
            key={pill.key}
            type="button"
            onClick={() => { setStatusFilter(statusFilter === pill.key ? '' : pill.key); setPage(0) }}
            className={`rounded-xl border px-4 py-3 text-left transition-colors ${pill.color} ${statusFilter === pill.key ? 'ring-2 ring-[#293F52]' : ''}`}
          >
            <div className="text-2xs font-semibold uppercase tracking-wide">{pill.label}</div>
            <div className="mt-1 text-xl font-bold">{statusCounts?.[pill.key] ?? 0}</div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2.5 px-7 py-4">
        <div className="flex w-60 items-center gap-2 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search ref, address, notes..."
            aria-label="Search illegal dumping reports"
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
          {BOOKING_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          value={areaFilter}
          onChange={(e) => { setAreaFilter(e.target.value); setPage(0) }}
          aria-label="Filter by area"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All Areas</option>
          {(areas ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
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
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Ref</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Location</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Area</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Collection Date</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Capacity</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Photos</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Status</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Reported</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500"></th>
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
                const photoCount = extractPhotoCount(b.notes)
                const ss = getStatusStyle('booking', b.status)
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
                      {photoCount > 0
                        ? <span className="rounded-full bg-gray-100 px-2 py-0.5 font-semibold text-gray-700">{photoCount}</span>
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${ss.bg} ${ss.text}`}>
                        {b.status}
                      </span>
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

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-md border border-gray-100 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-xs text-gray-500">Page {page + 1} of {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="rounded-md border border-gray-100 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </>
  )
}
