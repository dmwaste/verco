'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { metricVisible } from '@/lib/reports/audience'
import {
  awstTimestampBounds,
  resolvePeriod,
  type PeriodFyRow,
  type PeriodPreset,
} from '@/lib/reports/periods'
import { PeriodSelector } from './period-selector'
import { ProvenanceStamp } from './sla-card'
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

  const bounds = awstTimestampBounds(period)
  const { data: stats, isLoading, isError: statsError } = useQuery({
    queryKey: [
      'report-stats',
      selectedArea,
      clientId,
      period.kind,
      period.fyId,
      period.from,
      period.to,
      period.unresolved,
      showRefunds,
    ],
    enabled: !period.unresolved,
    queryFn: async () => {
      // Bookings by status — period anchor: booking created_at (booked-in-
      // period; FY presets use the FY's date bounds here since the status
      // breakdown is a workload view, not an FY-attributed KPI).
      let bookingQuery = supabase
        .from('booking')
        .select('status', { count: 'exact', head: false })
      if (clientId) bookingQuery = bookingQuery.eq('client_id', clientId)
      if (selectedArea) bookingQuery = bookingQuery.eq('collection_area_id', selectedArea)
      if (bounds.gte) bookingQuery = bookingQuery.gte('created_at', bounds.gte)
      if (bounds.lt) bookingQuery = bookingQuery.lt('created_at', bounds.lt)

      // Refund totals — contractor-only (VER-288): skip the query entirely
      // for council viewers. Period anchor: none — refunds stay all-time
      // (money reconciliation, not a period KPI).
      const refundQuery = showRefunds
        ? supabase.from('refund_request').select('amount_cents, status').eq('client_id', clientId)
        : null

      // Open tickets — snapshot (open is open regardless of period).
      let ticketQuery = supabase
        .from('service_ticket')
        .select('id', { count: 'exact', head: true })
        .in('status', ['open', 'in_progress'])
      if (clientId) ticketQuery = ticketQuery.eq('client_id', clientId)

      // Independent queries — no waterfall; any failure throws (isError) —
      // a failed fetch must never read as zero bookings/tickets.
      const [bookingRes, refundRes, ticketRes] = await Promise.all([
        bookingQuery,
        refundQuery,
        ticketQuery,
      ])
      for (const res of [bookingRes, refundRes, ticketRes]) {
        if (res?.error) throw new Error(res.error.message)
      }

      const statusCounts: Record<string, number> = {}
      for (const b of bookingRes.data ?? []) {
        statusCounts[b.status] = (statusCounts[b.status] ?? 0) + 1
      }

      const refunds = refundRes?.data ?? []
      const refundPending = refunds.filter((r) => r.status === 'pending').reduce((sum, r) => sum + r.amount_cents, 0)
      const refundProcessed = refunds.filter((r) => r.status === 'processed').reduce((sum, r) => sum + r.amount_cents, 0)

      return {
        statusCounts,
        // Exact count from PostgREST — immune to the max_rows=1000 row cap.
        // The status BREAKDOWN still reflects at most 1,000 rows; converting
        // it to an in-DB GROUP BY RPC is tracked follow-up work.
        totalBookings: bookingRes.count ?? bookingRes.data?.length ?? 0,
        statusRowsCapped: (bookingRes.count ?? 0) > (bookingRes.data?.length ?? 0),
        refundPending,
        refundProcessed,
        openTickets: ticketRes.count ?? 0,
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
        {period.unresolved && (
          <p className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2 text-body-sm text-blue-800">
            {preset === 'custom'
              ? 'Enter a date to apply the custom period.'
              : 'No matching financial year for this period — cards are paused rather than showing all-time data.'}
          </p>
        )}
        {/* VER-179 SLA dashboard + M2 delta cards — share the period + area scope. */}
        <div className="mb-6">
          <SlaDashboard
            clientId={clientId}
            selectedArea={selectedArea}
            period={period}
            viewerRole={viewerRole}
          />
        </div>

        {statsError ? (
          <p className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-2 text-body-sm text-amber-800">
            Couldn&apos;t load the booking summary — reload the page or try again shortly.
          </p>
        ) : isLoading && !period.unresolved ? (
          <p className="text-sm text-gray-400">Loading reports...</p>
        ) : stats ? (
          <div className="space-y-6">
            {/* Summary cards — NCN/NP counts were retired for the three-way
                Open Notices split card in the dashboard above (VER-294). */}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="rounded-xl bg-white p-5 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Total Bookings</p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">{stats.totalBookings}</p>
                <ProvenanceStamp text={`${stamp} · booked in period`} />
              </div>
              <div className="rounded-xl bg-white p-5 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Open Tickets</p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">{stats.openTickets}</p>
                <ProvenanceStamp text="Live · Current snapshot" />
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
              {stats.statusRowsCapped && (
                <p className="mt-3 text-[11px] text-amber-600">
                  Breakdown reflects the first 1,000 bookings of {stats.totalBookings} in this period.
                </p>
              )}
              <ProvenanceStamp text={`${stamp} · booked in period`} />
            </div>

            {/* Refund summary — contractor-only (VER-288) */}
            {showRefunds && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-xl bg-white p-5 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Refunds Pending</p>
                  <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-amber-600">
                    ${(stats.refundPending / 100).toFixed(2)}
                  </p>
                  <ProvenanceStamp text="Live · All time" />
                </div>
                <div className="rounded-xl bg-white p-5 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Refunds Processed</p>
                  <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-emerald-600">
                    ${(stats.refundProcessed / 100).toFixed(2)}
                  </p>
                  <ProvenanceStamp text="Live · All time" />
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </>
  )
}
