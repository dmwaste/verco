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
import { DonutChart } from './donut-chart'
import { PeriodSelector } from './period-selector'
import { CardLabel, ProvenanceStamp, SlaCard } from './sla-card'
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
      // Bookings by status — SERVICE-period anchor (review 02/07): fy presets
      // → fy_id, range presets → item collection_date inside the window.
      // created_at surfaced legacy-imported bookings under Last FY/Last month.
      let bookingQuery = period.kind === 'fy'
        ? supabase
            .from('booking')
            .select('status', { count: 'exact', head: false })
            .eq('fy_id', period.fyId!)
        : (() => {
            let q = supabase
              .from('booking')
              .select('status, booking_item!inner(collection_date!inner(date))', {
                count: 'exact',
                head: false,
              })
            if (period.from) q = q.gte('booking_item.collection_date.date', period.from)
            if (period.to) q = q.lte('booking_item.collection_date.date', period.to)
            return q
          })()
      if (clientId) bookingQuery = bookingQuery.eq('client_id', clientId)
      if (selectedArea) bookingQuery = bookingQuery.eq('collection_area_id', selectedArea)

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

  // Donut segment colours — same hue semantics as the status pills used
  // across the admin (emerald confirmed, purple scheduled, amber NP, …).
  const STATUS_DONUT_COLORS: Record<string, string> = {
    Submitted: '#3B82F6',
    Confirmed: '#10B981',
    Scheduled: '#8B5CF6',
    Completed: '#293F52',
    Cancelled: '#D1D5DB',
    'Non-conformance': '#F87171',
    'Nothing Presented': '#F59E0B',
    Rebooked: '#60A5FA',
  }
  const STATUS_DONUT_FALLBACK = '#9CA3AF'

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
            aria-label="Collection area"
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
          <p className="text-sm text-gray-500">Loading reports…</p>
        ) : stats ? (
          <div className="space-y-6">
            {/* Summary cards — NCN/NP counts were retired for the three-way
                Open Notices split card in the dashboard above (VER-294).
                One auto-fit grid: the card count varies by audience (refunds
                are contractor-only), so columns derive from content — no
                orphan slots for any viewer (design review 02/07 F-005). */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] gap-4">
              <SlaCard
                label="Total Bookings"
                value={String(stats.totalBookings)}
                provenance={`${stamp} · by service date`}
              />
              <SlaCard
                label="Open Tickets"
                value={String(stats.openTickets)}
                provenance="Live · Current snapshot"
              />
              {/* Refund summary — contractor-only (VER-288). Amber = money
                  waiting on action, green = settled (matches the SLA tones). */}
              {showRefunds && (
                <SlaCard
                  label="Refunds Pending"
                  value={`$${(stats.refundPending / 100).toFixed(2)}`}
                  tone="below"
                  provenance="Live · All time"
                />
              )}
              {showRefunds && (
                <SlaCard
                  label="Refunds Processed"
                  value={`$${(stats.refundProcessed / 100).toFixed(2)}`}
                  tone="pass"
                  provenance="Live · All time"
                />
              )}
            </div>

            {/* Bookings by status — a chart panel, but its title sits at the
                CARD level, not the page-section level (CardLabel, not h2). */}
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <div className="mb-4">
                <CardLabel text="Bookings by Status" />
              </div>
              {Object.keys(stats.statusCounts).length === 0 ? (
                <p className="text-[11px] text-gray-500">No bookings in this period.</p>
              ) : (
                <DonutChart
                  ariaLabel="Bookings by status"
                  segments={Object.entries(stats.statusCounts)
                    .sort(([, a], [, b]) => b - a)
                    .map(([status, count]) => ({
                      label: status,
                      value: count,
                      color: STATUS_DONUT_COLORS[status] ?? STATUS_DONUT_FALLBACK,
                    }))}
                />
              )}
              {stats.statusRowsCapped && (
                <p className="mt-3 text-[11px] text-amber-700">
                  Breakdown reflects the first 1,000 bookings of {stats.totalBookings} in this period.
                </p>
              )}
              <ProvenanceStamp text={`${stamp} · by service date`} />
            </div>

          </div>
        ) : null}
      </div>
    </>
  )
}
