'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { metricVisible } from '@/lib/reports/audience'
import {
  resolvePeriod,
  type PeriodFyRow,
  type PeriodPreset,
} from '@/lib/reports/periods'
import { PeriodSelector } from './period-selector'
import { SlaDashboard } from './sla-dashboard'

export function ReportsClient({
  clientId,
  fyRows,
  viewerRole,
}: {
  clientId: string
  fyRows: PeriodFyRow[]
  viewerRole: string | null
}) {
  const supabase = createClient()
  const [selectedArea, setSelectedArea] = useState('')
  // VER-297 standard periods — presets replace the old free date inputs;
  // Custom reveals them again. Default: This FY (the KPI reporting frame).
  const [preset, setPreset] = useState<PeriodPreset>('this-fy')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  // VER-288 (8A): refunds are monetary — contractor-only. Structural gate:
  // the refund query never runs for council viewers, not just hidden.
  const showRefunds = metricVisible('refunds', viewerRole)

  const period = useMemo(
    () =>
      resolvePeriod(preset, new Date(), fyRows, {
        from: customFrom || undefined,
        to: customTo || undefined,
      }),
    [preset, fyRows, customFrom, customTo],
  )

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
    queryKey: [
      'report-stats',
      selectedArea,
      clientId,
      period.kind,
      period.fyId,
      period.from,
      period.to,
      showRefunds,
    ],
    queryFn: async () => {
      // Bookings by status — period anchor: booking created_at (booked-in-
      // period; FY presets use the FY's date bounds here since the status
      // breakdown is a workload view, not an FY-attributed KPI).
      let bookingQuery = supabase
        .from('booking')
        .select('status', { count: 'exact', head: false })
      if (clientId) bookingQuery = bookingQuery.eq('client_id', clientId)
      if (selectedArea) bookingQuery = bookingQuery.eq('collection_area_id', selectedArea)
      if (period.from) bookingQuery = bookingQuery.gte('created_at', `${period.from}T00:00:00+08:00`)
      if (period.to) bookingQuery = bookingQuery.lte('created_at', `${period.to}T23:59:59+08:00`)
      const { data: bookings } = await bookingQuery

      const statusCounts: Record<string, number> = {}
      for (const b of bookings ?? []) {
        statusCounts[b.status] = (statusCounts[b.status] ?? 0) + 1
      }

      // Refund totals — contractor-only (VER-288): skip the query entirely
      // for council viewers. Period anchor: requested_at is not selected —
      // refunds stay all-time (money reconciliation, not a period KPI).
      let refundPending = 0
      let refundProcessed = 0
      if (showRefunds) {
        let refundQuery = supabase.from('refund_request').select('amount_cents, status')
        if (clientId) refundQuery = refundQuery.eq('client_id', clientId)
        const { data: refunds } = await refundQuery
        refundPending = (refunds ?? []).filter((r) => r.status === 'pending').reduce((sum, r) => sum + r.amount_cents, 0)
        refundProcessed = (refunds ?? []).filter((r) => r.status === 'processed').reduce((sum, r) => sum + r.amount_cents, 0)
      }

      // Open tickets — snapshot (open is open regardless of period).
      let ticketQuery = supabase
        .from('service_ticket')
        .select('id', { count: 'exact', head: true })
        .in('status', ['open', 'in_progress'])
      if (clientId) ticketQuery = ticketQuery.eq('client_id', clientId)
      const { count: openTickets } = await ticketQuery

      return {
        statusCounts,
        totalBookings: bookings?.length ?? 0,
        refundPending,
        refundProcessed,
        openTickets: openTickets ?? 0,
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

  const stamp = `Live · ${period.label}`

  return (
    <>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Reports
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            Overview of booking and operational metrics
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodSelector
            preset={preset}
            onPresetChange={setPreset}
            customFrom={customFrom}
            customTo={customTo}
            onCustomChange={(from, to) => {
              setCustomFrom(from)
              setCustomTo(to)
            }}
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
        </div>
      </div>

      <div className="px-7 py-6">
        {/* VER-179 SLA dashboard + M2 delta cards — share the period + area scope. */}
        <div className="mb-6">
          <SlaDashboard
            clientId={clientId}
            selectedArea={selectedArea}
            period={period}
            viewerRole={viewerRole}
          />
        </div>

        {isLoading ? (
          <p className="text-sm text-gray-400">Loading reports...</p>
        ) : stats ? (
          <div className="space-y-6">
            {/* Summary cards — NCN/NP counts were retired for the three-way
                Open Notices split card in the dashboard above (VER-294). */}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="rounded-xl bg-white p-5 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Total Bookings</p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">{stats.totalBookings}</p>
                <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-300">{stamp} · booked in period</p>
              </div>
              <div className="rounded-xl bg-white p-5 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Open Tickets</p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">{stats.openTickets}</p>
                <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-300">Live · Current snapshot</p>
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
              <p className="mt-3 text-[10px] font-medium uppercase tracking-wide text-gray-300">{stamp} · booked in period</p>
            </div>

            {/* Refund summary — contractor-only (VER-288) */}
            {showRefunds && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-xl bg-white p-5 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Refunds Pending</p>
                  <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-amber-600">
                    ${(stats.refundPending / 100).toFixed(2)}
                  </p>
                  <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-300">Live · All time</p>
                </div>
                <div className="rounded-xl bg-white p-5 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Refunds Processed</p>
                  <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-emerald-600">
                    ${(stats.refundProcessed / 100).toFixed(2)}
                  </p>
                  <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-300">Live · All time</p>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </>
  )
}
