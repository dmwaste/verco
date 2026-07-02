'use client'

/**
 * SLA Dashboard — VER-179 Phase 3 consumer (spec §3, §5), extended by the M2
 * dashboard build (VER-294 delta cards · VER-297 period slicers + trendlines ·
 * VER-290 provenance stamps).
 *
 * Cards are thin renderers: each runs its own RLS-scoped PostgREST query (or a
 * tenant-guarded RPC), folds rows through a tested pure fn from
 * `src/lib/reports/*`, and hands display strings to <SlaCard>. Nothing here
 * does business maths — the maths lives in the 100%-tested calc layer.
 *
 * Query strategy (spec §5.2): client PostgREST by default; RPC only where
 * PostgREST physically can't (RECT — audit_log jsonb + working-day math;
 * PENETRATION — COUNT(DISTINCT) over a ~110k-row denominator; monthly
 * trendlines — in-DB bucketing, never row-fetch-then-bucket past
 * max_rows=1000). Every card keys its query on the full period scope.
 * ⚠ Known at-scale debt (review 02/07): the row-fetching headline cards
 * (BC, ONTIME, SELFSVC, VOLMIX, RS, NOTIF) truncate at max_rows=1000 once a
 * tenant's FY exceeds 1,000 rows — converting them to aggregate RPCs is the
 * follow-up that also unlocks their trendlines (tracked in Linear).
 *
 * Period semantics (VER-297) — the period changes WHICH rows are counted,
 * never HOW a metric is measured. `period.unresolved` (no matching FY row /
 * empty Custom) DISABLES every query — running with null bounds would
 * silently widen to all-time under the selected-period stamp.
 *
 * BOOKING-OBJECT cards anchor on the SERVICE period, never created_at
 * (review 02/07): legacy-imported and pre-season bookings are created long
 * before their service window, so created_at made "Last FY / Last month"
 * report activity that never happened. EVENT cards keep their event anchor —
 * an email sent in June IS June activity. Per card:
 *   BC        fy presets → booking.fy_id (the service FY); range presets →
 *             item collection_date.date inside the window
 *   ONTIME    scheduled collection_date.date
 *   RECT      notice reported_at (RPC p_from/p_to)
 *   SR/SELFSVC/NOTIF  event created_at (NOTIF also ignores the area filter
 *             by design — notification_log has no area)
 *   RS        survey submitted_at
 *   VOLMIX    fy presets → fy_id; range presets → item collection_date.date
 *   TREND     booking service date = MIN item collection_date.date (RPC)
 *   NOTICES   snapshot of OPEN notices — deliberately period-INDEPENDENT
 *             (an open notice is open regardless of the selected period);
 *             its trendline shows notices raised per month, rolling 12
 * Timestamptz bounds come from awstTimestampBounds (exclusive next-day upper
 * bound, matching the RPCs' AWST-date semantics).
 *
 * Audience gating (VER-288, decision 8A): every card has an audience declared
 * in `lib/reports/audience.ts` — contractor-only cards (penetration,
 * self-service, notification delivery) are never mounted for council viewers,
 * so their queries never fire. New cards default contractor-only.
 */

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { metricVisible } from '@/lib/reports/audience'
import {
  awstTimestampBounds,
  rolling12From,
  zeroFillMonths,
  type PeriodRange,
} from '@/lib/reports/periods'
import {
  computeNoticeSplit,
  NCN_TERMINAL_STATUSES,
  NP_TERMINAL_STATUSES,
  type NoticeRow,
} from '@/lib/reports/notice-split'
import { CardLabel, ProvenanceStamp, SlaCard, scorecardTone } from './sla-card'
import { Sparkline, type TrendPoint } from './sparkline'
import { DonutChart } from './donut-chart'
import { useReportsMonthly } from './use-reports-monthly'
import {
  cleanCollectionPoints,
  percentPoints,
  type MonthlyPoint,
} from '@/lib/reports/monthly-series'
import {
  computeCleanCollection,
  CLEAN_TARGET_PCT,
} from '@/lib/reports/clean-collection'
import { computeOnTime, ON_TIME_TARGET_PCT } from '@/lib/reports/on-time'
import {
  computeServiceTicketSla,
  RESPONSE_TARGET_WD,
  RESOLUTION_TARGET_DAYS,
} from '@/lib/reports/service-ticket-sla'
import {
  computeNotificationReliability,
  NOTIF_TARGET_PCT,
} from '@/lib/reports/notification-reliability'
import { computeSelfServiceRate } from '@/lib/reports/self-service'
import { computeVolumeMix } from '@/lib/reports/volume-mix'
import { computePenetration } from '@/lib/reports/penetration'
import {
  computeSurveyRating,
  RS_TARGET_PCT,
  type ResidentSatisfactionResult,
} from '@/lib/reports/resident-satisfaction'

/** Booking statuses that "reached the field" this FY (BC denominator, spec §3.1). */
const BC_ELIGIBLE_STATUSES = [
  'Completed',
  'Non-conformance',
  'Nothing Presented',
  'Scheduled',
  'Missed Collection',
] as const

/** PostgREST `.not('status','in',...)` literals for the terminal sets. */
const NCN_TERMINAL_IN = `(${NCN_TERMINAL_STATUSES.map((s) => `"${s}"`).join(',')})`
const NP_TERMINAL_IN = `(${NP_TERMINAL_STATUSES.map((s) => `"${s}"`).join(',')})`

/** Format a 0–100 number as a 1-dp percentage. */
function pct1(pct: number): string {
  return `${(Math.round(pct * 10) / 10).toFixed(1)}%`
}

interface CardScope {
  clientId: string
  /** Empty string = All Areas. */
  area: string
  /** Resolved standard period (VER-297) — bounds, kind, fyId, label. */
  period: PeriodRange
}

/** queryKey fragment covering the full period scope. */
function periodKey(period: PeriodRange): (string | boolean | null)[] {
  return [period.kind, period.fyId, period.from, period.to, period.unresolved]
}

/** Card provenance stamp (VER-290): live cards state period + freshness. */
function liveStamp(period: PeriodRange): string {
  return `Live · ${period.label}`
}

type RpcRow = Record<string, unknown>

/**
 * Throws on PostgREST errors so TanStack surfaces isError and the card
 * renders "Couldn't load" — a failed fetch must never read as an
 * authoritative zero on a council-facing SLA card (review 02/07).
 */
function orThrow<T>(res: { data: T | null; error: { message: string } | null }): T | null {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

/**
 * Shared rolling-12 trendline query (VER-297): one place owns the window
 * anchor (computed per render and INCLUDED in the queryKey so a month
 * rollover in a long-lived tab re-keys the cache instead of silently mixing
 * windows), the RPC arg shape, and the zero-filled TrendPoint mapping.
 */
function useMonthlyTrend(
  name: string,
  clientId: string,
  area: string,
  call: (anchor: string) => PromiseLike<{
    data: RpcRow[] | null
    error: { message: string } | null
  }>,
  mapRow: (r: RpcRow) => number,
) {
  const now = new Date()
  const anchor = rolling12From(now)
  return useQuery({
    queryKey: [name, clientId, area, anchor],
    enabled: !!clientId,
    queryFn: async () => {
      const rows = orThrow(await call(anchor))
      const observed = (rows ?? []).map((r) => ({
        month: String(r.month),
        value: mapRow(r),
      }))
      return zeroFillMonths(observed, anchor, now) as TrendPoint[]
    },
  })
}

/**
 * % variant of useMonthlyTrend for the dedicated monthly RPCs: observed
 * months only — a month with no denominator is "no data", never 0%
 * (zero-filling a rate would draw fake 0% cliffs).
 */
function useMonthlyPercentTrend(
  name: string,
  clientId: string,
  area: string,
  call: (anchor: string) => PromiseLike<{
    data: RpcRow[] | null
    error: { message: string } | null
  }>,
  numKey: string,
  denKey: string,
) {
  const anchor = rolling12From(new Date())
  return useQuery({
    queryKey: [name, clientId, area, anchor],
    enabled: !!clientId,
    queryFn: async () => {
      const rows = orThrow(await call(anchor)) ?? []
      return rows
        .filter((r) => Number(r[denKey] ?? 0) > 0)
        .map((r) => ({
          month: String(r.month),
          value: Math.round((Number(r[numKey] ?? 0) / Number(r[denKey])) * 1000) / 10,
        })) as TrendPoint[]
    },
  })
}

/** Footer slot for a rate sparkline — omitted until there are observed months. */
function pctSpark(points: readonly MonthlyPoint[] | undefined, caption: string) {
  return points && points.length > 0 ? (
    <Sparkline points={points as TrendPoint[]} caption={caption} />
  ) : undefined
}

export function SlaDashboard({ clientId, selectedArea, period, viewerRole }: {
  clientId: string
  selectedArea: string
  period: PeriodRange
  viewerRole: string | null
}) {
  const scope: CardScope = { clientId, area: selectedArea, period }
  // VER-288 (8A): per-metric audience gating. Contractor-only cards are not
  // MOUNTED for council viewers — their queries never fire (structural, not
  // CSS-hidden). New cards default contractor-only in lib/reports/audience.ts.
  const show = (metric: string) => metricVisible(metric, viewerRole)

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-sm font-bold text-[#293F52]">
          Insights
        </h2>
        {/* Side by side (design feedback 02/07) — auto-fit so a lone card
            (audience-gated sibling) still fills the row. Open Notices moved
            to the page top line (reports-client); Penetration lives in the
            Service Level grid (batch 3). */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-4">
          {show('collections-trend') && <CollectionsTrendCard {...scope} />}
          {show('service-breakdown') && <VolumeMixCard {...scope} />}
        </div>
      </section>

      {show('customer-satisfaction') && (
        <section>
          <h2 className="mb-3 font-[family-name:var(--font-heading)] text-sm font-bold text-[#293F52]">
            Customer Satisfaction
          </h2>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] gap-4">
            <CustomerSatisfactionCards {...scope} />
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-sm font-bold text-[#293F52]">
          Service Level
        </h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {show('service-delivery') && <BcCard {...scope} />}
          {show('on-time-collection') && <OnTimeCard {...scope} />}
          {show('rectification') && <RectCard {...scope} />}
          {(show('ticket-first-response') || show('ticket-resolution')) && <SrCards {...scope} />}
          {show('self-service-rate') && <SelfServiceCard {...scope} />}
          {show('notification-delivery') && <NotifCard {...scope} />}
          {/* Quarter-width here per design batch 3 (was an Insights card). */}
          {show('property-penetration') && <PenetrationCard {...scope} />}
        </div>
      </section>
    </div>
  )
}

// ── BC — Clean Collection Rate (spec §3.1) ──────────────────────────────────
// Period anchor: SERVICE period, never created_at (design review 02/07 —
// legacy-imported and pre-season bookings made "Last FY / Last month" report
// activity that never happened). fy presets → booking.fy_id (the service FY);
// range presets → item collection_date.date inside the window.
function BcCard({ clientId, area, period }: CardScope) {
  const supabase = createClient()
  const fyScoped = period.kind === 'fy'
  const monthly = useReportsMonthly(clientId, area)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sla-bc', clientId, area, ...periodKey(period)],
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      let elig = fyScoped
        ? supabase.from('booking').select('id').eq('fy_id', period.fyId!)
        : (() => {
            let q = supabase
              .from('booking')
              .select('id, booking_item!inner(collection_date!inner(date))')
            if (period.from) q = q.gte('booking_item.collection_date.date', period.from)
            if (period.to) q = q.lte('booking_item.collection_date.date', period.to)
            return q
          })()
      elig = elig
        .eq('client_id', clientId)
        .is('deleted_at', null)
        .in('status', BC_ELIGIBLE_STATUSES)
      if (area) elig = elig.eq('collection_area_id', area)

      // Contractor-fault NCNs, scoped via the EXPLICIT booking FK (NCN has two
      // FKs to booking — the multi-FK embed trap; alias the intake FK).
      let ncn = fyScoped
        ? supabase
            .from('non_conformance_notice')
            .select(
              'booking_id, orig:booking!non_conformance_notice_booking_id_fkey!inner(collection_area_id, fy_id, deleted_at)'
            )
            .eq('orig.fy_id', period.fyId!)
        : (() => {
            let q = supabase
              .from('non_conformance_notice')
              .select(
                'booking_id, orig:booking!non_conformance_notice_booking_id_fkey!inner(collection_area_id, deleted_at, booking_item!inner(collection_date!inner(date)))'
              )
            if (period.from) q = q.gte('orig.booking_item.collection_date.date', period.from)
            if (period.to) q = q.lte('orig.booking_item.collection_date.date', period.to)
            return q
          })()
      ncn = ncn
        .eq('client_id', clientId)
        .eq('contractor_fault', true)
        .is('orig.deleted_at', null)
      if (area) ncn = ncn.eq('orig.collection_area_id', area)

      // Independent queries — no waterfall; either failure throws (isError).
      // Explicit orThrow params: the fy/range branches select different embed
      // shapes, and only these fields are read from either.
      const [eligRes, ncnRes] = await Promise.all([elig, ncn])
      const eligRows = orThrow<{ id: string }[]>(eligRes)
      const ncnRows = orThrow<{ booking_id: string }[]>(ncnRes)
      const eligibleBookingIds = new Set((eligRows ?? []).map((r) => r.id))
      const contractorFaultNcnBookingIds = new Set(
        (ncnRows ?? []).map((r) => r.booking_id)
      )

      return computeCleanCollection({ eligibleBookingIds, contractorFaultNcnBookingIds })
    },
  })

  if (period.unresolved) {
    return <SlaCard label="Service Delivery" value="—" sub="Period unavailable" provenance={liveStamp(period)} />
  }
  const r = data
  // Empty states render as muted SUB text under an em-dash value — a long
  // phrase in the value slot shouts louder than real data (review F-003).
  const value = !r || r.isEmpty ? '—'
    : r.isLowN ? `${r.eligible - r.miss} / ${r.eligible}`
    : pct1(r.pct!)
  const sub = !r ? undefined
    : r.isEmpty ? 'No collections yet'
    : r.isLowN ? 'Building data' : `${r.eligible - r.miss} / ${r.eligible} clean`
  return (
    <SlaCard
      label="Service Delivery"
      isLoading={isLoading}
      isError={isError}
      value={value}
      sub={sub}
      tone={r ? scorecardTone(r.pct, CLEAN_TARGET_PCT, r) : 'neutral'}
      target={`Target ≥ ${CLEAN_TARGET_PCT}%`}
      provenance={liveStamp(period)}
      footer={pctSpark(cleanCollectionPoints(monthly.rows), 'Clean collection % · last 12 months')}
    />
  )
}

// ── ONTIME — On-Time Collection (spec §3.2) ─────────────────────────────────
// Period anchor: scheduled collection_date.date. Trendline: get_on_time_monthly
// (in-DB month buckets; history starts at the June-2026 stops model).
function OnTimeCard({ clientId, area, period }: CardScope) {
  const supabase = createClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sla-ontime', clientId, area, ...periodKey(period)],
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      let q = supabase
        .from('collection_stop')
        .select('completed_at, collection_date:collection_date_id!inner(date, collection_area_id)')
        .eq('status', 'Completed')
        .not('completed_at', 'is', null)
        .eq('client_id', clientId)
      if (area) q = q.eq('collection_date.collection_area_id', area)
      if (period.from) q = q.gte('collection_date.date', period.from)
      if (period.to) q = q.lte('collection_date.date', period.to)
      const rows = orThrow(await q)
      const stops = (rows ?? []).map((row) => {
        const cd = Array.isArray(row.collection_date) ? row.collection_date[0] : row.collection_date
        return { completed_at: row.completed_at as string, scheduledDate: cd?.date as string }
      })
      return computeOnTime(stops)
    },
  })

  // Monthly % (design 02/07) — was completed-stop counts.
  const { data: trend } = useMonthlyPercentTrend(
    'sla-ontime-trend-pct',
    clientId,
    area,
    (anchor) =>
      supabase.rpc('get_on_time_monthly', {
        p_client_id: clientId,
        p_area_id: area || undefined,
        p_from: anchor,
      }),
    'on_time',
    'completed',
  )

  if (period.unresolved) {
    return <SlaCard label="On-Time Collection" value="—" sub="Period unavailable" provenance={liveStamp(period)} />
  }
  const r = data
  const value = !r || r.isEmpty ? '—'
    : r.isLowN ? `${r.onTime} / ${r.completed}` : pct1(r.pct!)
  const sub = !r ? undefined
    : r.isEmpty ? 'No completed stops'
    : r.isLowN ? 'Building data' : `${r.onTime} / ${r.completed} on time`
  return (
    <SlaCard
      label="On-Time Collection"
      isLoading={isLoading}
      isError={isError}
      value={value}
      sub={sub}
      tone={r ? scorecardTone(r.pct, ON_TIME_TARGET_PCT, r) : 'neutral'}
      target={`Target ≥ ${ON_TIME_TARGET_PCT}%`}
      provenance={liveStamp(period)}
      footer={pctSpark(trend, 'On-time % · last 12 months')}
    />
  )
}

// ── RECT — Rectification ≤ 2 working days (spec §3.3, RPC) ───────────────────
// Period anchor: notice reported_at (RPC p_from/p_to).
const RECT_TARGET_PCT = 90

function RectCard({ clientId, area, period }: CardScope) {
  const supabase = createClient()
  const monthly = useReportsMonthly(clientId, area)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sla-rect', clientId, area, ...periodKey(period)],
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      const rows = orThrow(
        await supabase.rpc('get_rect_sla', {
          p_client_id: clientId,
          p_area_id: area || undefined,
          p_from: period.from ?? undefined,
          p_to: period.to ?? undefined,
        }),
      )
      return (rows ?? [])[0] ?? { numerator: 0, denominator: 0, pct: null }
    },
  })
  if (period.unresolved) {
    return <SlaCard label="Rectification ≤ 2 Days" value="—" sub="Period unavailable" provenance={liveStamp(period)} />
  }
  const r = data
  const denom = r?.denominator ?? 0
  const isEmpty = denom === 0
  const isLowN = denom > 0 && denom < 5
  const value = !r || isEmpty ? '—'
    : isLowN ? `${r.numerator} / ${denom}` : pct1(Number(r.pct))
  const sub = !r ? undefined
    : isEmpty ? 'No rectifications'
    : isLowN ? 'Building data' : `${r.numerator} / ${denom} within 2 working days`
  return (
    <SlaCard
      label="Rectification ≤ 2 Days"
      isLoading={isLoading}
      isError={isError}
      value={value}
      sub={sub}
      tone={r ? scorecardTone(r.pct === null ? null : Number(r.pct), RECT_TARGET_PCT, { isEmpty, isLowN }) : 'neutral'}
      target={`Target ≥ ${RECT_TARGET_PCT}%`}
      provenance={liveStamp(period)}
      footer={pctSpark(
        percentPoints(monthly.rows, 'rect_num', 'rect_den'),
        'Rectified ≤ 2 working days % · last 12 months',
      )}
    />
  )
}

// ── SR — Service Ticket SLA: response + resolution (spec §3.4) ───────────────
// Period anchor: ticket created_at.
function SrCards({ clientId, area, period }: CardScope) {
  const supabase = createClient()
  const monthly = useReportsMonthly(clientId, area)
  const bounds = awstTimestampBounds(period)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sla-sr', clientId, area, ...periodKey(period)],
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      let q = area
        ? supabase
            .from('service_ticket')
            .select('created_at, first_response_at, resolved_at, closed_at, booking!inner(collection_area_id)')
            .eq('client_id', clientId)
            .eq('booking.collection_area_id', area)
        : supabase
            .from('service_ticket')
            .select('created_at, first_response_at, resolved_at, closed_at')
            .eq('client_id', clientId)
      if (bounds.gte) q = q.gte('created_at', bounds.gte)
      if (bounds.lt) q = q.lt('created_at', bounds.lt)
      // Holidays are independent of the ticket rows — no waterfall.
      const [waHolidays, ticketRes] = await Promise.all([fetchWaHolidays(supabase), q])
      const rows = orThrow(ticketRes)
      const tickets = (rows ?? []).map((t) => ({
        createdAtAwst: awstDateFromUtc(new Date(t.created_at)),
        firstResponseAtAwst: t.first_response_at ? awstDateFromUtc(new Date(t.first_response_at)) : null,
        resolvedAtUtc: (t.resolved_at ?? t.closed_at) as string | null,
      }))
      return computeServiceTicketSla({ tickets, waHolidays })
    },
  })

  if (period.unresolved) {
    return (
      <>
        <SlaCard label="Ticket First Response" value="—" sub="Period unavailable" provenance={liveStamp(period)} />
        <SlaCard label="Ticket Resolution" value="—" sub="Period unavailable" provenance={liveStamp(period)} />
      </>
    )
  }
  const resp = data?.responded
  const res = data?.resolved
  return (
    <>
      <SlaCard
        label="Ticket First Response"
        isLoading={isLoading}
        isError={isError}
        value={
          !resp || resp.isEmpty ? '—'
            : resp.isLowN ? `${resp.withinTarget} / ${resp.n}` : pct1(resp.pct!)
        }
        sub={
          !resp ? undefined
            : resp.isEmpty ? 'Tracking starts soon'
            : resp.isLowN ? 'Building data' : `${resp.withinTarget} / ${resp.n} in time`
        }
        tone={resp ? scorecardTone(resp.pct, 100, resp) : 'neutral'}
        target={`Target ≤ ${RESPONSE_TARGET_WD} working days`}
        provenance={liveStamp(period)}
        footer={pctSpark(
          percentPoints(monthly.rows, 'resp_num', 'resp_den'),
          `Responded ≤ ${RESPONSE_TARGET_WD} working days % · last 12 months`,
        )}
      />
      <SlaCard
        label="Ticket Resolution"
        isLoading={isLoading}
        isError={isError}
        value={
          !res || res.isEmpty ? '—'
            : res.isLowN ? `${res.withinTarget} / ${res.n}` : pct1(res.pct!)
        }
        sub={
          !res ? undefined
            : res.isEmpty ? 'No resolved tickets'
            : res.isLowN ? 'Building data' : `${res.withinTarget} / ${res.n} in time`
        }
        tone={res ? scorecardTone(res.pct, 100, res) : 'neutral'}
        target={`Target ≤ ${RESOLUTION_TARGET_DAYS} days`}
        provenance={liveStamp(period)}
      />
    </>
  )
}

// ── SELFSVC — Self-Service Rate (spec §3.6, contractor-only per 8A) ──────────
// Period anchor: booking created_at.
const SELF_SERVICE_TARGET_PCT = 80

function SelfServiceCard({ clientId, area, period }: CardScope) {
  const supabase = createClient()
  const monthly = useReportsMonthly(clientId, area)
  const bounds = awstTimestampBounds(period)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sla-selfsvc', clientId, area, ...periodKey(period)],
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      let q = supabase
        .from('booking')
        .select('created_via, type, status')
        .eq('client_id', clientId)
      if (area) q = q.eq('collection_area_id', area)
      if (bounds.gte) q = q.gte('created_at', bounds.gte)
      if (bounds.lt) q = q.lt('created_at', bounds.lt)
      const rows = orThrow(await q)
      return computeSelfServiceRate(rows ?? [])
    },
  })
  if (period.unresolved) {
    return <SlaCard label="Self-Service Rate" value="—" sub="Period unavailable" provenance={liveStamp(period)} />
  }
  const r = data
  const value = !r || r.isEmpty ? '—'
    : r.isLowN ? `${r.selfServed} / ${r.inScope}` : pct1(r.pct!)
  const sub = !r ? undefined
    : r.isEmpty
      ? r.excludedLegacy > 0
        ? `Tracking starts soon · ${r.excludedLegacy} earlier bookings excluded`
        : 'Tracking starts soon'
      : r.isLowN ? 'Building data' : `${r.selfServed} / ${r.inScope} resident-created`
  return (
    <SlaCard
      label="Self-Service Rate"
      isLoading={isLoading}
      isError={isError}
      value={value}
      sub={sub}
      tone="neutral"
      target={`Target ≥ ${SELF_SERVICE_TARGET_PCT}%`}
      provenance={liveStamp(period)}
      footer={pctSpark(
        percentPoints(monthly.rows, 'self_served', 'self_scope'),
        'Self-service % · last 12 months',
      )}
    />
  )
}

// ── NOTIF — Notification Reliability (email only, no area filter, spec §3.7) ─
// Period anchor: notification_log created_at. Contractor-only per 8A.
function NotifCard({ clientId, area, period }: CardScope) {
  const supabase = createClient()
  // Same hook args as sibling cards so TanStack dedupes to one fetch; the
  // notif series itself ignores the area filter (matches the card).
  const monthly = useReportsMonthly(clientId, area)
  const bounds = awstTimestampBounds(period)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sla-notif', clientId, ...periodKey(period)],
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      let q = supabase
        .from('notification_log')
        .select('delivery_status')
        .eq('client_id', clientId)
        .eq('channel', 'email')
        .not('delivery_status', 'is', null)
      if (bounds.gte) q = q.gte('created_at', bounds.gte)
      if (bounds.lt) q = q.lt('created_at', bounds.lt)
      const rows = orThrow(await q)
      return computeNotificationReliability((rows ?? []).map((r) => r.delivery_status))
    },
  })
  if (period.unresolved) {
    return <SlaCard label="Notification Delivery" value="—" sub="Period unavailable" provenance={liveStamp(period)} />
  }
  const r = data
  const value = !r || r.isEmpty ? '—'
    : r.isLowN ? `${r.positive} / ${r.tracked}` : pct1(r.pct!)
  const sub = !r ? 'Email only'
    : r.isEmpty ? 'No tracked email · email only'
    : r.isLowN ? 'Building data' : `${r.positive} / ${r.tracked} delivered · email only`
  return (
    <SlaCard
      label="Notification Delivery"
      isLoading={isLoading}
      isError={isError}
      value={value}
      sub={sub}
      tone={r ? scorecardTone(r.pct, NOTIF_TARGET_PCT, r) : 'neutral'}
      target={`Target ≥ ${NOTIF_TARGET_PCT}%`}
      provenance={liveStamp(period)}
      footer={pctSpark(
        percentPoints(monthly.rows, 'notif_delivered', 'notif_tracked'),
        'Delivered % · last 12 months',
      )}
    />
  )
}

// ── PENETRATION — Property Penetration (insight, spec §3.9, RPC) ─────────────
// Period anchor: booking created_at (booked-during-period); the eligible
// denominator is point-in-time by design. Contractor-only per 8A.
function PenetrationCard({ clientId, area, period }: CardScope) {
  const supabase = createClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sla-penetration', clientId, area, ...periodKey(period)],
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      const rows = orThrow(
        await supabase.rpc('get_property_penetration', {
          p_client_id: clientId,
          p_area_id: area || undefined,
          p_from: period.from ?? undefined,
          p_to: period.to ?? undefined,
        }),
      )
      const row = (rows ?? [])[0] ?? { booked: 0, eligible: 0 }
      return { result: computePenetration({ booked: Number(row.booked), eligible: Number(row.eligible) }), booked: Number(row.booked) }
    },
  })
  if (period.unresolved) {
    return <SlaCard label="Property Penetration" value="—" sub="Period unavailable" provenance={liveStamp(period)} />
  }
  const r = data?.result
  return (
    <SlaCard
      label="Property Penetration"
      isLoading={isLoading}
      isError={isError}
      value={!r ? '—' : r.display}
      sub={!r || r.isEmpty ? undefined : r.isLowN ? 'Building data' : 'of eligible properties'}
      tone="neutral"
      provenance={liveStamp(period)}
    />
  )
}

// ── Customer Satisfaction — booking / service / overall (design 02/07) ──────
// Period anchor: survey submitted_at. ONE survey fetch feeds all three cards;
// each folds its own `responses` key (booking_rating / collection_rating /
// overall_rating — the exact keys the survey form writes).
function CustomerSatisfactionCards({ clientId, area, period }: CardScope) {
  const supabase = createClient()
  const monthly = useReportsMonthly(clientId, area)
  const bounds = awstTimestampBounds(period)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sla-csat', clientId, area, ...periodKey(period)],
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      // For "All Areas" drop the embed (avoids multi-FK fragility); booking_survey
      // has a single booking FK so the inner embed is safe when an area is set.
      let q = area
        ? supabase
            .from('booking_survey')
            .select('responses, booking!inner(collection_area_id)')
            .not('submitted_at', 'is', null)
            .eq('client_id', clientId)
            .eq('booking.collection_area_id', area)
        : supabase
            .from('booking_survey')
            .select('responses')
            .not('submitted_at', 'is', null)
            .eq('client_id', clientId)
      if (bounds.gte) q = q.gte('submitted_at', bounds.gte)
      if (bounds.lt) q = q.lt('submitted_at', bounds.lt)
      const rows = orThrow(await q)
      const surveyRows = (rows ?? []).map((r) => ({ responses: r.responses }))
      return {
        booking: computeSurveyRating(surveyRows, 'booking_rating'),
        service: computeSurveyRating(surveyRows, 'collection_rating'),
        overall: computeSurveyRating(surveyRows, 'overall_rating'),
      }
    },
  })

  const card = (
    label: string,
    r: ResidentSatisfactionResult | undefined,
    seriesKey: 'booking' | 'service' | 'overall',
    target?: string,
  ) => {
    if (period.unresolved) {
      return <SlaCard key={label} label={label} value="—" sub="Period unavailable" provenance={liveStamp(period)} />
    }
    const value = !r || r.isEmpty ? '—'
      : r.isLowN ? `${r.good} / ${r.n}` : pct1(r.pct!)
    const sub = !r ? undefined
      : r.isEmpty ? 'No responses yet'
      : r.isLowN ? 'Building data' : `${r.good} / ${r.n} rated 4+`
    return (
      <SlaCard
        key={label}
        label={label}
        isLoading={isLoading}
        isError={isError}
        value={value}
        sub={sub}
        tone="neutral"
        target={target}
        provenance={liveStamp(period)}
        footer={pctSpark(
          percentPoints(monthly.rows, `csat_${seriesKey}_good`, `csat_${seriesKey}_n`),
          'Rated 4+ % · last 12 months',
        )}
      />
    )
  }

  return (
    <>
      {card('Booking Rating', data?.booking, 'booking')}
      {card('Service Rating', data?.service, 'service')}
      {card('Overall Rating', data?.overall, 'overall', `Reference ≥ ${RS_TARGET_PCT}%`)}
    </>
  )
}

// ── NOTICES — Open NCN + NP, three-way responsibility split (VER-294) ────────
// Snapshot of OPEN notices — deliberately period-independent (an open notice
// is open regardless of the selected period). Terminal statuses are excluded
// IN THE QUERY (terminal history accumulates forever; open notices are
// naturally bounded by the 14-day auto-close, so the fetched set stays small
// and never hits max_rows=1000). Trendline: notices RAISED per month, rolling
// 12, via get_notices_monthly. Split semantics live in the tested pure fn
// (lib/reports/notice-split.ts) and MUST match the council definitions doc
// v1.0 §3 (resident-fault presumption + 14-day dispute window stated there).
export function OpenNoticesCard({ clientId, area }: CardScope) {
  const supabase = createClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sla-notices', clientId, area],
    enabled: !!clientId,
    queryFn: async () => {
      // Area filtering joins each notice's INTAKE booking — NCN has two booking
      // FKs (rescheduled too), so the FK is aliased explicitly (§21 trap).
      let ncn = area
        ? supabase
            .from('non_conformance_notice')
            .select('status, contractor_fault, orig:booking!non_conformance_notice_booking_id_fkey!inner(collection_area_id)')
            .eq('client_id', clientId)
            .eq('orig.collection_area_id', area)
        : supabase
            .from('non_conformance_notice')
            .select('status, contractor_fault')
            .eq('client_id', clientId)
      ncn = ncn.not('status', 'in', NCN_TERMINAL_IN)
      let np = area
        ? supabase
            .from('nothing_presented')
            .select('status, contractor_fault, orig:booking!nothing_presented_booking_id_fkey!inner(collection_area_id)')
            .eq('client_id', clientId)
            .eq('orig.collection_area_id', area)
        : supabase
            .from('nothing_presented')
            .select('status, contractor_fault')
            .eq('client_id', clientId)
      np = np.not('status', 'in', NP_TERMINAL_IN)
      const [ncnRes, npRes] = await Promise.all([ncn, np])
      const ncnRows = orThrow(ncnRes)
      const npRows = orThrow(npRes)
      const rows: NoticeRow[] = [
        ...(ncnRows ?? []).map((r) => ({ table: 'ncn' as const, status: String(r.status), contractor_fault: !!r.contractor_fault })),
        ...(npRows ?? []).map((r) => ({ table: 'np' as const, status: String(r.status), contractor_fault: !!r.contractor_fault })),
      ]
      // computeNoticeSplit re-applies the terminal exclusion — a harmless
      // defence-in-depth no-op now that the query filters server-side.
      return computeNoticeSplit(rows)
    },
  })

  const { data: trend } = useMonthlyTrend(
    'sla-notices-trend',
    clientId,
    area,
    (anchor) =>
      supabase.rpc('get_notices_monthly', {
        p_client_id: clientId,
        p_area_id: area || undefined,
        p_from: anchor,
      }),
    (r) =>
      Number(r.ncn_contractor ?? 0) + Number(r.ncn_other ?? 0) +
      Number(r.np_contractor ?? 0) + Number(r.np_other ?? 0),
  )

  const s = data
  return (
    <SlaCard
      label="Open Notices"
      isLoading={isLoading}
      isError={isError}
      value={s ? String(s.open) : '—'}
      sub={
        s && s.open > 0
          ? `${s.contractor} contractor fault · ${s.underInvestigation} under investigation · ${s.resident} resident (incl. presumed)`
          : s
            ? 'No open notices'
            : undefined
      }
      tone="neutral"
      provenance="Live · Current snapshot"
      footer={
        trend && trend.length > 0 ? (
          <Sparkline points={trend} caption="Notices raised · last 12 months" />
        ) : undefined
      }
    />
  )
}

// ── TREND — Collections per Period (VER-294, full-width, RPC) ────────────────
// Delivered collections (Completed bookings, one each, month of MIN item
// service date — the definitions doc v1.0 §2 basis). Headline = selected
// period total; bars = rolling last 12 months. History starts at platform
// adoption (the go-live cliff) — the caption says so.
function CollectionsTrendCard({ clientId, area, period }: CardScope) {
  const supabase = createClient()

  const { data: periodTotal, isLoading } = useQuery({
    queryKey: ['sla-trend-total', clientId, area, ...periodKey(period)],
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      const rows = orThrow(
        await supabase.rpc('get_collections_trend', {
          p_client_id: clientId,
          p_area_id: area || undefined,
          p_from: period.from ?? undefined,
          p_to: period.to ?? undefined,
        }),
      )
      return (rows ?? []).reduce((sum, r) => sum + Number(r.collections ?? 0), 0)
    },
  })

  const { data: trend } = useMonthlyTrend(
    'sla-trend-bars',
    clientId,
    area,
    (anchor) =>
      supabase.rpc('get_collections_trend', {
        p_client_id: clientId,
        p_area_id: area || undefined,
        p_from: anchor,
      }),
    (r) => Number(r.collections ?? 0),
  )

  return (
    <SlaCard
      label="Collections per Period"
      isLoading={!period.unresolved && (isLoading || periodTotal === undefined)}
      value={period.unresolved ? '—' : String(periodTotal ?? 0)}
      sub={
        period.unresolved
          ? 'Period unavailable'
          : 'Completed collections — the current month grows as collections complete'
      }
      provenance={liveStamp(period)}
      footer={
        trend && trend.length > 0 ? (
          <Sparkline
            points={trend}
            caption="Completed collections per month · last 12 months · history starts at platform adoption"
          />
        ) : undefined
      }
    />
  )
}

// ── VOLMIX — Service Breakdown (insight, donut, spec §3.8) ───────────────────
// Period anchor: service date (fy_id / item collection_date) — see header.

/**
 * Fixed per-service segment colours, matching the admin dashboard's convention
 * (bulk/green split + ANC_COLORS in admin/page.tsx). Keyed by display name; an
 * unmapped or renamed service falls back to a palette colour rather than
 * vanishing. The fallback is positional (indexed by qty rank), so it is stable
 * per-render, not stable per-service — map every live service explicitly to
 * pin its colour. Covers all six current waste streams incl. Illegal Dumping.
 */
const SERVICE_COLORS: Record<string, string> = {
  'Bulk Waste': '#00E47C',
  'Green Waste': '#00B864',
  Mattress: '#8FA5B8',
  'E-Waste': '#FF8C42',
  Whitegoods: '#3A5A73',
  'Illegal Dumping': '#7E6BA6',
}
const SERVICE_COLOR_FALLBACK = ['#6B8299', '#B0763A', '#26506B', '#93A7B8']

function VolumeMixCard({ clientId, area, period }: CardScope) {
  const supabase = createClient()
  const fyScoped = period.kind === 'fy'
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sla-volmix', clientId, area, ...periodKey(period)],
    enabled: !!clientId && !period.unresolved,
    queryFn: async () => {
      // Service-date anchor (review 02/07): fy presets → fy_id, range presets
      // → item collection_date inside the window — never created_at, which
      // surfaced legacy-imported bookings under Last FY / Last month.
      let q = fyScoped
        ? supabase
            .from('booking')
            .select('booking_item(no_services, actual_services, is_extra, service!inner(name, waste_stream))')
            .eq('fy_id', period.fyId!)
        : (() => {
            let ranged = supabase
              .from('booking')
              .select(
                'booking_item!inner(no_services, actual_services, is_extra, service!inner(name, waste_stream), collection_date!inner(date))'
              )
            if (period.from) ranged = ranged.gte('booking_item.collection_date.date', period.from)
            if (period.to) ranged = ranged.lte('booking_item.collection_date.date', period.to)
            return ranged
          })()
      q = q
        .eq('client_id', clientId)
        .not('status', 'in', '("Cancelled","Pending Payment")')
      if (area) q = q.eq('collection_area_id', area)
      const rows = orThrow(await q)
      const flat = (rows ?? []).flatMap((b) => {
        const items = (b.booking_item ?? []) as Array<{
          no_services: number
          actual_services: number | null
          is_extra: boolean
          service: { name: string; waste_stream: string } | { name: string; waste_stream: string }[] | null
        }>
        return items.map((it) => {
          const svc = Array.isArray(it.service) ? it.service[0] : it.service
          return {
            no_services: it.no_services,
            actual_services: it.actual_services,
            is_extra: it.is_extra,
            waste_stream: (svc?.waste_stream ?? 'general') as never,
            service_name: svc?.name ?? 'Unknown',
          }
        })
      })
      return computeVolumeMix(flat)
    },
  })
  const r = data
  const hasData = !!r && !r.isEmpty && !period.unresolved && !isError
  // Chart panel, not a KPI card (design batch 3): no headline number — the
  // donut IS the content, with the provenance stamp as the panel footer.
  return (
    <div className="flex flex-col rounded-xl bg-white p-5 shadow-sm">
      <CardLabel text="Service Breakdown" />
      <div className="flex flex-1 items-center py-3">
        {period.unresolved ? (
          <p className="text-[11px] text-gray-500">Period unavailable.</p>
        ) : isError ? (
          <p className="font-[family-name:var(--font-heading)] text-sm font-bold text-amber-600">
            Couldn&apos;t load
          </p>
        ) : isLoading || !r ? (
          <p className="text-[11px] text-gray-500">Loading…</p>
        ) : r.isEmpty ? (
          <p className="text-[11px] text-gray-500">No collections match these filters.</p>
        ) : (
          <DonutChart
            svgClassName="h-36 w-36"
            ariaLabel="Service breakdown"
            segments={r.byService.map((s, i) => ({
              label: s.name,
              value: s.qty,
              color:
                SERVICE_COLORS[s.name] ??
                SERVICE_COLOR_FALLBACK[i % SERVICE_COLOR_FALLBACK.length],
            }))}
          />
        )}
      </div>
      {hasData && (
        <p className="text-[11px] text-gray-500">
          {r.freeUnits} included · {r.extraUnits} extra
          {r.isLowN ? ' · building data' : ''}
        </p>
      )}
      <div className="mt-auto">
        <ProvenanceStamp text={`${liveStamp(period)} · by service date`} />
      </div>
    </div>
  )
}

/** WA public-holiday dates (YYYY-MM-DD) for the SR first-response working-day window. */
async function fetchWaHolidays(supabase: ReturnType<typeof createClient>): Promise<string[]> {
  const { data } = await supabase.from('public_holiday').select('date').eq('jurisdiction', 'WA')
  return (data ?? []).map((h) => h.date)
}
