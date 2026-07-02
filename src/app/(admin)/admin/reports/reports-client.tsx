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
import { countPoints, SERIES } from '@/lib/reports/monthly-series'
import { PeriodSelector } from './period-selector'
import { SlaCard } from './sla-card'
import { CollectionsTrendCard, OpenNoticesCard, SlaDashboard } from './sla-dashboard'
import { Sparkline } from './sparkline'
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
    // clientId gate + unconditional tenant filter (red team 02/07): with a
    // null-resolved tenant, a contractor session would otherwise count
    // tickets ACROSS tenants under a tenantless page.
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      // Open tickets — snapshot (open is open regardless of period). A failed
      // fetch throws (isError) — never reads as zero tickets. (Total Bookings
      // was replaced by Total Collections, batch 5 — its query went with it.)
      const ticketRes = await supabase
        .from('service_ticket')
        .select('id', { count: 'exact', head: true })
        .in('status', ['open', 'in_progress'])
        .eq('client_id', clientId)
      if (ticketRes.error) throw new Error(ticketRes.error.message)

      return { openTickets: ticketRes.count ?? 0 }
    },
  })

  // VER-288 (8A) gating for the page-level cards; the SLA dashboard gates its
  // own cards internally.
  const show = (metric: string) => metricVisible(metric, viewerRole)

  // Rolling-12 tail for Open Tickets. AREA-AGNOSTIC (red team 02/07): the
  // headline snapshot has no area dimension, so its tail must not change
  // under the area filter either. With no area selected this shares the
  // dashboard's fetch (identical queryKey); with one selected it is the lone
  // extra request.
  const monthly = useReportsMonthly(clientId, '')
  const countSpark = (series: string, caption: string) => {
    // Zero-filled tails only render off a SUCCESSFUL fetch — an errored one
    // would draw a misleading flat-zero year.
    if (!monthly.isSuccess) return undefined
    const points = countPoints(monthly.rows, series, monthly.anchor, monthly.now)
    return points.length > 0 ? <Sparkline points={points} caption={caption} /> : undefined
  }

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
          {show('collections-trend') && (
            <CollectionsTrendCard clientId={clientId} area={selectedArea} period={period} />
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
              footer={countSpark(SERIES.tickets, 'Tickets per month · last 12 months')}
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
