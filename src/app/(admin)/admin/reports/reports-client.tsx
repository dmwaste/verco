'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import {
  resolvePeriod,
  type PeriodFyRow,
  type PeriodPreset,
} from '@/lib/reports/periods'
import { metricVisible } from '@/lib/reports/audience'
import { countPoints } from '@/lib/reports/monthly-series'
import { PeriodSelector } from './period-selector'
import { SlaCard } from './sla-card'
import { OpenNoticesCard, SlaDashboard } from './sla-dashboard'
import { Sparkline, type TrendPoint } from './sparkline'
import { useReportsMonthly } from './use-reports-monthly'

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
    ],
    enabled: !period.unresolved,
    queryFn: async () => {
      // Total bookings — SERVICE-period anchor (review 02/07): fy presets →
      // fy_id, range presets → item collection_date inside the window
      // (created_at surfaced legacy-imported bookings under Last FY/Last
      // month). Count-only HEAD request: PostgREST's exact count is immune to
      // the max_rows=1000 row cap and no rows are needed since the status
      // chart was removed (design batch 3).
      let bookingQuery = period.kind === 'fy'
        ? supabase
            .from('booking')
            .select('id', { count: 'exact', head: true })
            .eq('fy_id', period.fyId!)
        : (() => {
            let q = supabase
              .from('booking')
              .select('id, booking_item!inner(collection_date!inner(date))', {
                count: 'exact',
                head: true,
              })
            if (period.from) q = q.gte('booking_item.collection_date.date', period.from)
            if (period.to) q = q.lte('booking_item.collection_date.date', period.to)
            return q
          })()
      if (clientId) bookingQuery = bookingQuery.eq('client_id', clientId)
      if (selectedArea) bookingQuery = bookingQuery.eq('collection_area_id', selectedArea)

      // Open tickets — snapshot (open is open regardless of period).
      let ticketQuery = supabase
        .from('service_ticket')
        .select('id', { count: 'exact', head: true })
        .in('status', ['open', 'in_progress'])
      if (clientId) ticketQuery = ticketQuery.eq('client_id', clientId)

      // Independent queries — no waterfall; any failure throws (isError) —
      // a failed fetch must never read as zero bookings/tickets.
      const [bookingRes, ticketRes] = await Promise.all([bookingQuery, ticketQuery])
      for (const res of [bookingRes, ticketRes]) {
        if (res?.error) throw new Error(res.error.message)
      }

      return {
        totalBookings: bookingRes.count ?? 0,
        openTickets: ticketRes.count ?? 0,
      }
    },
  })

  // VER-288 (8A) gating for the page-level cards; the SLA dashboard gates its
  // own cards internally.
  const show = (metric: string) => metricVisible(metric, viewerRole)

  // Rolling-12 volume sparklines (design 02/07) — shared fetch with every
  // dashboard card via the common queryKey.
  const monthly = useReportsMonthly(clientId, selectedArea)
  const countSpark = (series: string, caption: string) => {
    const points = countPoints(monthly.rows, series, monthly.anchor, monthly.now)
    return points.length > 0 ? (
      <Sparkline points={points as TrendPoint[]} caption={caption} />
    ) : undefined
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
        {/* Top line (design batch 3): the three at-a-glance counts, 1/3 wide.
            NCN/NP raw counts were retired for the three-way Open Notices
            split (VER-294); refunds and the status chart were removed
            entirely (02/07) — money and status workload live on their own
            admin pages. */}
        <div className="mb-6 grid gap-4 md:grid-cols-3">
          {show('total-bookings') && (
            <SlaCard
              label="Total Bookings"
              isLoading={isLoading && !period.unresolved}
              isError={statsError}
              value={period.unresolved ? '—' : String(stats?.totalBookings ?? 0)}
              sub={period.unresolved ? 'Period unavailable' : undefined}
              provenance={`${stamp} · by service date`}
              footer={countSpark('bookings', 'Bookings per month · last 12 months')}
            />
          )}
          {show('open-notices') && (
            <OpenNoticesCard clientId={clientId} area={selectedArea} period={period} />
          )}
          {show('open-tickets') && (
            <SlaCard
              label="Open Tickets"
              isLoading={isLoading && !period.unresolved}
              isError={statsError}
              value={period.unresolved ? '—' : String(stats?.openTickets ?? 0)}
              sub={period.unresolved ? 'Period unavailable' : undefined}
              provenance="Live · Current snapshot"
              footer={countSpark('tickets', 'Tickets per month · last 12 months')}
            />
          )}
        </div>

        {/* VER-179 SLA dashboard + M2 delta cards — share the period + area scope. */}
        <SlaDashboard
          clientId={clientId}
          selectedArea={selectedArea}
          period={period}
          viewerRole={viewerRole}
        />
      </div>
    </>
  )
}
