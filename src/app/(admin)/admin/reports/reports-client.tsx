'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import {
  countByWasteStream,
  WASTE_STREAM_LABELS,
  WASTE_STREAM_ORDER,
} from '@/lib/reports/waste-stream'

export function ReportsClient({ clientId }: { clientId: string }) {
  const supabase = createClient()
  const [selectedArea, setSelectedArea] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const { data: areas } = useQuery({
    queryKey: ['report-areas', clientId],
    queryFn: async () => {
      let q = supabase
        .from('collection_area')
        .select('id, code, name')
        .eq('is_active', true)
        .order('code')
      if (clientId) q = q.eq('client_id', clientId)
      const { data } = await q
      return data ?? []
    },
  })

  const { data: stats, isLoading } = useQuery({
    queryKey: ['report-stats', selectedArea, clientId, dateFrom, dateTo],
    queryFn: async () => {
      // Bookings by status
      let bookingQuery = supabase
        .from('booking')
        .select('status', { count: 'exact', head: false })
      if (clientId) bookingQuery = bookingQuery.eq('client_id', clientId)
      if (selectedArea) bookingQuery = bookingQuery.eq('collection_area_id', selectedArea)
      if (dateFrom) bookingQuery = bookingQuery.gte('created_at', `${dateFrom}T00:00:00+08:00`)
      if (dateTo) bookingQuery = bookingQuery.lte('created_at', `${dateTo}T23:59:59+08:00`)
      const { data: bookings } = await bookingQuery

      const statusCounts: Record<string, number> = {}
      for (const b of bookings ?? []) {
        statusCounts[b.status] = (statusCounts[b.status] ?? 0) + 1
      }

      // Collections by waste stream (booking_item -> service.waste_stream), same filters.
      let wasteQuery = supabase
        .from('booking_item')
        .select(
          'no_services, service!inner(waste_stream), booking!inner(client_id, collection_area_id, status, created_at)'
        )
        .not('booking.status', 'in', '("Cancelled","Pending Payment")')
      if (clientId) wasteQuery = wasteQuery.eq('booking.client_id', clientId)
      if (selectedArea) wasteQuery = wasteQuery.eq('booking.collection_area_id', selectedArea)
      if (dateFrom) wasteQuery = wasteQuery.gte('booking.created_at', `${dateFrom}T00:00:00+08:00`)
      if (dateTo) wasteQuery = wasteQuery.lte('booking.created_at', `${dateTo}T23:59:59+08:00`)
      const { data: wasteItems } = await wasteQuery
      // Count by units booked (no_services), not rows — matches the rest of the app.
      const wasteCounts = countByWasteStream(
        ((wasteItems ?? []) as unknown as Array<{
          no_services: number
          service: { waste_stream: string | null } | { waste_stream: string | null }[] | null
        }>).map((it) => {
          const svc = Array.isArray(it.service) ? it.service[0] : it.service
          return { stream: svc?.waste_stream ?? null, quantity: it.no_services ?? 0 }
        })
      )

      // NCN count
      let ncnQuery = supabase.from('non_conformance_notice').select('id', { count: 'exact', head: true })
      if (clientId) ncnQuery = ncnQuery.eq('client_id', clientId)
      const { count: ncnCount } = await ncnQuery

      // NP count
      let npQuery = supabase.from('nothing_presented').select('id', { count: 'exact', head: true })
      if (clientId) npQuery = npQuery.eq('client_id', clientId)
      const { count: npCount } = await npQuery

      // Refund totals
      let refundQuery = supabase.from('refund_request').select('amount_cents, status')
      if (clientId) refundQuery = refundQuery.eq('client_id', clientId)
      const { data: refunds } = await refundQuery
      const refundPending = (refunds ?? []).filter((r) => r.status === 'pending').reduce((sum, r) => sum + r.amount_cents, 0)
      const refundProcessed = (refunds ?? []).filter((r) => r.status === 'processed').reduce((sum, r) => sum + r.amount_cents, 0)

      // Open tickets
      let ticketQuery = supabase
        .from('service_ticket')
        .select('id', { count: 'exact', head: true })
        .in('status', ['open', 'in_progress'])
      if (clientId) ticketQuery = ticketQuery.eq('client_id', clientId)
      const { count: openTickets } = await ticketQuery

      return {
        statusCounts,
        totalBookings: bookings?.length ?? 0,
        ncnCount: ncnCount ?? 0,
        npCount: npCount ?? 0,
        refundPending,
        refundProcessed,
        openTickets: openTickets ?? 0,
        wasteCounts,
      }
    },
  })

  const STATUS_COLORS: Record<string, string> = {
    Submitted: 'bg-blue-100 text-blue-700',
    Confirmed: 'bg-emerald-100 text-emerald-700',
    Scheduled: 'bg-purple-100 text-purple-700',
    Completed: 'bg-gray-100 text-gray-700',
    Cancelled: 'bg-gray-100 text-gray-500',
    'Non-conformance': 'bg-red-100 text-red-700',
    'Nothing Presented': 'bg-amber-100 text-amber-700',
    Rebooked: 'bg-blue-100 text-blue-700',
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Reports
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            Overview of booking and operational metrics
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Booked</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="From date"
            className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
          />
          <span className="text-body-sm text-gray-400">–</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="To date"
            className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
          />
          <select
            value={selectedArea}
            onChange={(e) => setSelectedArea(e.target.value)}
            className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
          >
            <option value="">All Areas</option>
            {(areas ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
            ))}
          </select>
          {(dateFrom || dateTo || selectedArea) && (
            <button
              type="button"
              onClick={() => { setDateFrom(''); setDateTo(''); setSelectedArea('') }}
              className="rounded-lg border border-gray-200 px-3 py-[7px] text-body-sm text-gray-600 hover:bg-gray-50"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="px-7 py-6">
        {isLoading ? (
          <p className="text-sm text-gray-400">Loading reports...</p>
        ) : stats ? (
          <div className="space-y-6">
            {/* Summary cards */}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="rounded-xl bg-white p-5 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Total Bookings</p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">{stats.totalBookings}</p>
              </div>
              <div className="rounded-xl bg-white p-5 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Non-Conformance</p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-red-600">{stats.ncnCount}</p>
              </div>
              <div className="rounded-xl bg-white p-5 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Nothing Presented</p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-amber-600">{stats.npCount}</p>
              </div>
              <div className="rounded-xl bg-white p-5 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Open Tickets</p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">{stats.openTickets}</p>
              </div>
            </div>

            {/* Bookings by status */}
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <h2 className="mb-4 font-[family-name:var(--font-heading)] text-sm font-bold text-[#293F52]">Bookings by Status</h2>
              <div className="space-y-2">
                {Object.entries(stats.statusCounts)
                  .sort(([, a], [, b]) => b - a)
                  .map(([status, count]) => (
                    <div key={status} className="flex items-center gap-3">
                      <span className={`inline-flex w-36 items-center justify-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {status}
                      </span>
                      <div className="flex-1">
                        <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                          <div
                            className="h-full rounded-full bg-[#293F52]"
                            style={{ width: `${Math.max(2, (count / stats.totalBookings) * 100)}%` }}
                          />
                        </div>
                      </div>
                      <span className="w-12 text-right text-body-sm font-semibold text-gray-700">{count}</span>
                    </div>
                  ))}
              </div>
            </div>

            {/* Collections by waste type */}
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <h2 className="mb-1 font-[family-name:var(--font-heading)] text-sm font-bold text-[#293F52]">Collections by Waste Type</h2>
              <p className="mb-4 text-[11px] text-gray-400">Units booked per stream — excludes cancelled and unpaid bookings.</p>
              {WASTE_STREAM_ORDER.filter((ws) => (stats.wasteCounts[ws] ?? 0) > 0).length === 0 ? (
                <p className="text-body-sm text-gray-400">No collections match these filters.</p>
              ) : (
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  {WASTE_STREAM_ORDER.filter((ws) => (stats.wasteCounts[ws] ?? 0) > 0).map((ws) => (
                    <div key={ws} className="rounded-lg border border-gray-100 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{WASTE_STREAM_LABELS[ws]}</p>
                      <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">{stats.wasteCounts[ws] ?? 0}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Refund summary */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-xl bg-white p-5 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Refunds Pending</p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-amber-600">
                  ${(stats.refundPending / 100).toFixed(2)}
                </p>
              </div>
              <div className="rounded-xl bg-white p-5 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Refunds Processed</p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-emerald-600">
                  ${(stats.refundProcessed / 100).toFixed(2)}
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}
