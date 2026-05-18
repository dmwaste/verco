'use client'

import { useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import { SkeletonRow } from '@/components/ui/skeleton'
import Link from 'next/link'
import type { Database } from '@/lib/supabase/types'

type BookingStatus = Database['public']['Enums']['booking_status']
type BookingType = Database['public']['Enums']['booking_type']

const STATUS_OPTIONS: BookingStatus[] = [
  'Pending Payment',
  'Submitted',
  'Confirmed',
  'Scheduled',
  'Completed',
  'Cancelled',
  'Non-conformance',
  'Nothing Presented',
]

const TYPE_OPTIONS: BookingType[] = [
  'Residential',
  'MUD',
  'Illegal Dumping',
]

const TYPE_DOT_COLOR: Record<string, string> = {
  Residential: 'bg-[#293F52]',
  MUD: 'bg-[#805AD5]',
  'Illegal Dumping': 'bg-[#FF8C42]',
  'Call Back - DM': 'bg-gray-400',
  'Call Back - Client': 'bg-gray-400',
}

const PAGE_SIZE = 20

interface BookingsListClientProps {
  isContractorAdmin: boolean
}

export function BookingsListClient({ isContractorAdmin }: BookingsListClientProps) {
  const searchParams = useSearchParams()
  const supabase = createClient()
  const [payingBookingId, setPayingBookingId] = useState<string | null>(null)

  const [search, setSearch] = useState(searchParams.get('search') ?? '')
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') ?? '')
  const [areaFilter, setAreaFilter] = useState(searchParams.get('area') ?? '')
  const [typeFilter, setTypeFilter] = useState(searchParams.get('type') ?? '')
  const [page, setPage] = useState(0)

  // Sync URL → state on soft-navigation. The top-bar AdminSearchBar calls
  // router.push('/admin/bookings?search=X'); when the user is already on
  // /admin/bookings, Next.js App Router doesn't remount this component, so
  // the useState initialisers above never re-fire. Without this effect,
  // the top-bar search appears to "do nothing" — the URL updates but the
  // bookings query stays on the previous search value.
  useEffect(() => {
    setSearch(searchParams.get('search') ?? '')
    setStatusFilter(searchParams.get('status') ?? '')
    setAreaFilter(searchParams.get('area') ?? '')
    setTypeFilter(searchParams.get('type') ?? '')
    setPage(0)
  }, [searchParams])

  // Fetch collection areas for filter dropdown
  const { data: areas } = useQuery({
    queryKey: ['collection-areas'],
    queryFn: async () => {
      const { data } = await supabase
        .from('collection_area')
        .select('id, code, name')
        .eq('is_active', true)
        .order('code')
      return data ?? []
    },
  })

  // Fetch bookings
  const { data: bookingsData, isLoading } = useQuery({
    queryKey: ['admin-bookings', search, statusFilter, areaFilter, typeFilter, page],
    queryFn: async () => {
      // Multi-column search: match against booking.ref, property formatted_address,
      // and contact full_name. booking.property_id and booking.contact_id are both
      // nullable, so we pre-fetch matching ids in two parallel queries and feed
      // them into .or() as .in(...) clauses. Forcing inner joins on these would
      // change which bookings appear in unfiltered results, so we keep the joins
      // as LEFT and do the filter explicitly. Pre-fetch is capped at 500 each so
      // a very broad query (e.g. "St") can't blow the URL length.
      let matchingPropertyIds: string[] = []
      let matchingContactIds: string[] = []
      if (search) {
        const [propMatches, contactMatches] = await Promise.all([
          supabase
            .from('eligible_properties')
            .select('id')
            .ilike('formatted_address', `%${search}%`)
            .limit(500),
          supabase
            .from('contacts')
            .select('id')
            .ilike('full_name', `%${search}%`)
            .limit(500),
        ])
        matchingPropertyIds = propMatches.data?.map((r) => r.id) ?? []
        matchingContactIds = contactMatches.data?.map((r) => r.id) ?? []
      }

      let query = supabase
        .from('booking')
        .select(
          `id, ref, status, type, location, created_at, property_id,
           eligible_properties:property_id(formatted_address, address),
           collection_area!inner(code, name),
           booking_item(no_services, service!inner(name), collection_date!inner(id, date))`,
          { count: 'exact' }
        )
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (statusFilter) {
        query = query.eq('status', statusFilter as BookingStatus)
      }
      if (areaFilter) {
        query = query.eq('collection_area_id', areaFilter)
      }
      if (typeFilter) {
        query = query.eq('type', typeFilter as BookingType)
      }
      if (search) {
        const orClauses = [`ref.ilike.%${search}%`]
        if (matchingPropertyIds.length > 0) {
          orClauses.push(`property_id.in.(${matchingPropertyIds.join(',')})`)
        }
        if (matchingContactIds.length > 0) {
          orClauses.push(`contact_id.in.(${matchingContactIds.join(',')})`)
        }
        query = query.or(orClauses.join(','))
      }

      const { data, count } = await query
      return { bookings: data ?? [], total: count ?? 0 }
    },
  })

  const bookings = bookingsData?.bookings ?? []
  const total = bookingsData?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  function getCollectionDate(booking: typeof bookings[number]): { id: string; date: string } | null {
    const items = booking.booking_item as Array<{ collection_date: { id: string; date: string } }>
    if (items.length === 0) return null
    const cd = items[0]?.collection_date
    if (!cd?.date) return null
    return cd
  }

  function getServicesSummary(booking: typeof bookings[number]): string {
    const items = booking.booking_item as Array<{ no_services: number; service: { name: string } }>
    return items
      .map((i) => `${(i.service as { name: string }).name} \u00d7 ${i.no_services}`)
      .join(', ')
  }

  function getAddress(booking: typeof bookings[number]): string {
    const prop = booking.eligible_properties as unknown as { formatted_address: string | null; address: string } | null
    if (!prop) return '—'
    return prop.formatted_address ?? prop.address
  }

  const handlePayNow = useCallback(async (bookingId: string) => {
    setPayingBookingId(bookingId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      const origin = window.location.origin
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/create-checkout`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            booking_id: bookingId,
            success_url: `${origin}/admin/bookings`,
            cancel_url: `${origin}/admin/bookings`,
          }),
        }
      )

      if (!res.ok) {
        console.error('create-checkout error:', res.status, await res.text())
        alert('Failed to create payment session')
        setPayingBookingId(null)
        return
      }

      const data = (await res.json()) as { checkout_url?: string }
      if (data.checkout_url) {
        window.location.href = data.checkout_url
      } else {
        alert('Failed to create payment session')
        setPayingBookingId(null)
      }
    } catch (err) {
      console.error('Pay now error:', err)
      alert('Failed to create payment session')
      setPayingBookingId(null)
    }
  }, [supabase])

  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Bookings
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            {total} bookings
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {isContractorAdmin && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-1.5 text-body-sm font-semibold text-gray-700"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Export CSV
            </button>
          )}
          <Link
            href="/book"
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white"
          >
            + New Booking
          </Link>
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
            placeholder="Search ref, address, name..."
            aria-label="Search bookings"
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
          value={areaFilter}
          onChange={(e) => { setAreaFilter(e.target.value); setPage(0) }}
          aria-label="Filter by area"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All Areas</option>
          {(areas ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.code}</option>
          ))}
        </select>

        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(0) }}
          aria-label="Filter by type"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All Types</option>
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <div className="flex-1" />

        <span className="text-xs text-gray-500">
          Showing {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Ref</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Address</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Type</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Services</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Collection Date</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Area</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Status</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Created</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <SkeletonRow key={i} columns={8} />
                  ))}
                </>
              )}
              {!isLoading && bookings.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-sm text-gray-400">No bookings found</td></tr>
              )}
              {bookings.map((booking) => {
                const collDate = getCollectionDate(booking)
                const area = booking.collection_area as unknown as { code: string }
                return (
                  <tr
                    key={booking.id}
                    className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/bookings/${booking.id}`}
                        className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52] hover:underline"
                      >
                        {booking.ref}
                      </Link>
                    </td>
                    <td className="max-w-[180px] truncate px-4 py-3 text-body-sm">
                      {booking.property_id ? (
                        <Link
                          href={`/admin/properties/${booking.property_id}`}
                          className="text-gray-900 hover:text-[#293F52] hover:underline"
                        >
                          {getAddress(booking)}
                        </Link>
                      ) : (
                        getAddress(booking)
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-700">
                        <span className={`size-1.5 shrink-0 rounded-full ${TYPE_DOT_COLOR[booking.type] ?? 'bg-gray-400'}`} />
                        {booking.type}
                      </span>
                    </td>
                    <td className="max-w-[160px] truncate px-4 py-3 text-xs">
                      {getServicesSummary(booking)}
                    </td>
                    <td className="px-4 py-3 text-body-sm">
                      {collDate ? (
                        <Link
                          href="/admin/collection-dates"
                          className="text-gray-900 hover:text-[#293F52] hover:underline"
                        >
                          {format(new Date(collDate.date + 'T00:00:00'), 'EEE d MMM yyyy')}
                        </Link>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {area.code}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <BookingStatusBadge status={booking.status} />
                        {booking.status === 'Pending Payment' && (
                          <button
                            type="button"
                            onClick={() => handlePayNow(booking.id)}
                            disabled={payingBookingId === booking.id}
                            className="inline-flex items-center rounded-md border-[1.5px] border-[#00B864] bg-[#E8FDF0] px-2 py-0.5 text-2xs font-semibold text-[#006A38] disabled:opacity-50"
                          >
                            {payingBookingId === booking.id ? '...' : 'Pay'}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {format(new Date(booking.created_at), 'd MMM')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
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
            <span className="text-xs text-gray-500">
              Page {page + 1} of {totalPages}
            </span>
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
