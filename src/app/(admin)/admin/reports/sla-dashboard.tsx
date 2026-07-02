'use client'

/**
 * SLA Dashboard — VER-179 Phase 3 consumer (spec §3, §5).
 *
 * Nine cards (6 SLA scorecards + 3 insight cards) rendered on the admin Reports
 * screen. Each card is a thin renderer: it runs its own RLS-scoped PostgREST
 * query (or one of the two server RPCs), folds the rows through a tested pure fn
 * from `src/lib/reports/*`, and hands the display strings to <SlaCard>. Nothing
 * here does business maths — the maths lives in the 100%-tested calc layer.
 *
 * Query strategy (spec §5.2): client PostgREST by default; RPC only where
 * PostgREST physically can't (RECT — audit_log jsonb + working-day math;
 * PENETRATION — COUNT(DISTINCT) over a ~110k-row denominator). Every card adds
 * `selectedArea` to its queryKey; BC also adds `currentFyId`. NOTIF ignores the
 * area filter by design (notification_log has no area, and OTP rows have no
 * booking).
 *
 * Audience gating (VER-288, decision 8A): every card has an audience declared
 * in `lib/reports/audience.ts` — contractor-only cards (penetration,
 * self-service, notification delivery) are never mounted for council viewers,
 * so their queries never fire. New cards default contractor-only.
 *
 * ⚠️ TYPE-GATED (PR-B): three seams reference schema that only lands when PR-A
 * (#226) reaches prod and `types.ts` is regenerated — the `get_rect_sla` and
 * `get_property_penetration` RPCs and `booking.created_via`. Until then `tsc`
 * reports exactly those three, and nothing else. They are marked inline.
 */

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { metricVisible } from '@/lib/reports/audience'
import { SlaCard, scorecardTone } from './sla-card'
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
  computeResidentSatisfaction,
  RS_TARGET_PCT,
} from '@/lib/reports/resident-satisfaction'

/** Booking statuses that "reached the field" this FY (BC denominator, spec §3.1). */
const BC_ELIGIBLE_STATUSES = [
  'Completed',
  'Non-conformance',
  'Nothing Presented',
  'Scheduled',
  'Missed Collection',
] as const

/** Format a 0–100 number as a 1-dp percentage. */
function pct1(pct: number): string {
  return `${(Math.round(pct * 10) / 10).toFixed(1)}%`
}

interface CardScope {
  clientId: string
  /** Empty string = All Areas. */
  area: string
  /** Resolved current FY id, or null (only BC needs it). */
  currentFyId: string | null
}

export function SlaDashboard({ clientId, currentFyId, selectedArea, viewerRole }: {
  clientId: string
  currentFyId: string | null
  selectedArea: string
  viewerRole: string | null
}) {
  const scope: CardScope = { clientId, area: selectedArea, currentFyId }
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
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {show('property-penetration') && <PenetrationCard {...scope} />}
          {show('resident-satisfaction') && <ResidentSatisfactionCard {...scope} />}
        </div>
        {show('service-breakdown') && <VolumeMixCard {...scope} />}
      </section>

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
        </div>
      </section>
    </div>
  )
}

// ── BC — Clean Collection Rate (spec §3.1) ──────────────────────────────────
function BcCard({ clientId, area, currentFyId }: CardScope) {
  const supabase = createClient()
  const { data, isLoading } = useQuery({
    queryKey: ['sla-bc', clientId, area, currentFyId],
    enabled: !!clientId && !!currentFyId,
    queryFn: async () => {
      // Eligible: bookings that reached the field this FY, client/area-scoped.
      let elig = supabase
        .from('booking')
        .select('id')
        .eq('client_id', clientId)
        .eq('fy_id', currentFyId!)
        .is('deleted_at', null)
        .in('status', BC_ELIGIBLE_STATUSES)
      if (area) elig = elig.eq('collection_area_id', area)
      const { data: eligRows } = await elig
      const eligibleBookingIds = new Set((eligRows ?? []).map((r) => r.id))

      // Contractor-fault NCNs, scoped via the EXPLICIT booking FK (NCN has two
      // FKs to booking — the multi-FK embed trap; alias the intake FK).
      let ncn = supabase
        .from('non_conformance_notice')
        .select(
          'booking_id, orig:booking!non_conformance_notice_booking_id_fkey!inner(collection_area_id, fy_id, deleted_at)'
        )
        .eq('client_id', clientId)
        .eq('contractor_fault', true)
        .eq('orig.fy_id', currentFyId!)
        .is('orig.deleted_at', null)
      if (area) ncn = ncn.eq('orig.collection_area_id', area)
      const { data: ncnRows } = await ncn
      const contractorFaultNcnBookingIds = new Set(
        (ncnRows ?? []).map((r) => r.booking_id)
      )

      return computeCleanCollection({ eligibleBookingIds, contractorFaultNcnBookingIds })
    },
  })

  if (!currentFyId) {
    return <SlaCard label="Service Delivery" value="—" sub="No current financial year" />
  }
  const r = data
  const value = !r ? '—' : r.isEmpty ? 'No collections yet'
    : r.isLowN ? `${r.eligible - r.miss} / ${r.eligible}`
    : pct1(r.pct!)
  const sub = !r || r.isEmpty ? undefined
    : r.isLowN ? 'Building data' : `${r.eligible - r.miss} / ${r.eligible} clean`
  return (
    <SlaCard
      label="Service Delivery"
      isLoading={isLoading}
      value={value}
      sub={sub}
      tone={r ? scorecardTone(r.pct, CLEAN_TARGET_PCT, r) : 'neutral'}
      target={`Target ≥ ${CLEAN_TARGET_PCT}%`}
    />
  )
}

// ── ONTIME — On-Time Collection (spec §3.2) ─────────────────────────────────
function OnTimeCard({ clientId, area }: CardScope) {
  const supabase = createClient()
  const { data, isLoading } = useQuery({
    queryKey: ['sla-ontime', clientId, area],
    enabled: !!clientId,
    queryFn: async () => {
      let q = supabase
        .from('collection_stop')
        .select('completed_at, collection_date:collection_date_id!inner(date, collection_area_id)')
        .eq('status', 'Completed')
        .not('completed_at', 'is', null)
        .eq('client_id', clientId)
      if (area) q = q.eq('collection_date.collection_area_id', area)
      const { data: rows } = await q
      const stops = (rows ?? []).map((row) => {
        const cd = Array.isArray(row.collection_date) ? row.collection_date[0] : row.collection_date
        return { completed_at: row.completed_at as string, scheduledDate: cd?.date as string }
      })
      return computeOnTime(stops)
    },
  })
  const r = data
  const value = !r ? '—' : r.isEmpty ? 'No completed stops'
    : r.isLowN ? `${r.onTime} / ${r.completed}` : pct1(r.pct!)
  const sub = !r || r.isEmpty ? undefined
    : r.isLowN ? 'Building data' : `${r.onTime} / ${r.completed} on time`
  return (
    <SlaCard
      label="On-Time Collection"
      isLoading={isLoading}
      value={value}
      sub={sub}
      tone={r ? scorecardTone(r.pct, ON_TIME_TARGET_PCT, r) : 'neutral'}
      target={`Target ≥ ${ON_TIME_TARGET_PCT}%`}
    />
  )
}

// ── RECT — Rectification ≤ 2 working days (spec §3.3, RPC) ───────────────────
function RectCard({ clientId, area }: CardScope) {
  const supabase = createClient()
  const { data, isLoading } = useQuery({
    queryKey: ['sla-rect', clientId, area],
    enabled: !!clientId,
    queryFn: async () => {
      // TYPE-GATED: get_rect_sla RPC lands with PR-A types regen.
      const { data: rows } = await supabase.rpc('get_rect_sla', {
        p_client_id: clientId,
        p_area_id: area || undefined,
      })
      const row = (rows ?? [])[0] ?? { numerator: 0, denominator: 0, pct: null }
      return row as { numerator: number; denominator: number; pct: number | null }
    },
  })
  const r = data
  const denom = r?.denominator ?? 0
  const isEmpty = denom === 0
  const isLowN = denom > 0 && denom < 5
  const value = !r ? '—' : isEmpty ? 'No rectifications'
    : isLowN ? `${r.numerator} / ${denom}` : pct1(Number(r.pct))
  const sub = !r || isEmpty ? undefined
    : isLowN ? 'Building data' : `${r.numerator} / ${denom} within 2 working days`
  return (
    <SlaCard
      label="Rectification ≤ 2 Days"
      isLoading={isLoading}
      value={value}
      sub={sub}
      tone={r ? scorecardTone(r.pct === null ? null : Number(r.pct), 90, { isEmpty, isLowN }) : 'neutral'}
      target="Target ≥ 90%"
    />
  )
}

// ── SR — Service Ticket SLA: response + resolution (spec §3.4) ───────────────
function SrCards({ clientId, area }: CardScope) {
  const supabase = createClient()
  const { data, isLoading } = useQuery({
    queryKey: ['sla-sr', clientId, area],
    enabled: !!clientId,
    queryFn: async () => {
      const waHolidays = await fetchWaHolidays(supabase)
      const q = area
        ? supabase
            .from('service_ticket')
            .select('created_at, first_response_at, resolved_at, closed_at, booking!inner(collection_area_id)')
            .eq('client_id', clientId)
            .eq('booking.collection_area_id', area)
        : supabase
            .from('service_ticket')
            .select('created_at, first_response_at, resolved_at, closed_at')
            .eq('client_id', clientId)
      const { data: rows } = await q
      const tickets = (rows ?? []).map((t) => ({
        createdAtAwst: awstDateFromUtc(new Date(t.created_at)),
        firstResponseAtAwst: t.first_response_at ? awstDateFromUtc(new Date(t.first_response_at)) : null,
        resolvedAtUtc: (t.resolved_at ?? t.closed_at) as string | null,
      }))
      return computeServiceTicketSla({ tickets, waHolidays })
    },
  })

  const resp = data?.responded
  const res = data?.resolved
  return (
    <>
      <SlaCard
        label="Ticket First Response"
        isLoading={isLoading}
        value={
          !resp ? '—' : resp.isEmpty ? 'Tracking starts soon'
            : resp.isLowN ? `${resp.withinTarget} / ${resp.n}` : pct1(resp.pct!)
        }
        sub={!resp || resp.isEmpty ? undefined : resp.isLowN ? 'Building data' : `${resp.withinTarget} / ${resp.n} in time`}
        tone={resp ? scorecardTone(resp.pct, 100, resp) : 'neutral'}
        target={`Target ≤ ${RESPONSE_TARGET_WD} working days`}
      />
      <SlaCard
        label="Ticket Resolution"
        isLoading={isLoading}
        value={
          !res ? '—' : res.isEmpty ? 'No resolved tickets'
            : res.isLowN ? `${res.withinTarget} / ${res.n}` : pct1(res.pct!)
        }
        sub={!res || res.isEmpty ? undefined : res.isLowN ? 'Building data' : `${res.withinTarget} / ${res.n} in time`}
        tone={res ? scorecardTone(res.pct, 100, res) : 'neutral'}
        target={`Target ≤ ${RESOLUTION_TARGET_DAYS} days`}
      />
    </>
  )
}

// ── SELFSVC — Self-Service Rate (spec §3.6) ─────────────────────────────────
function SelfServiceCard({ clientId, area }: CardScope) {
  const supabase = createClient()
  const { data, isLoading } = useQuery({
    queryKey: ['sla-selfsvc', clientId, area],
    enabled: !!clientId,
    queryFn: async () => {
      // TYPE-GATED: booking.created_via lands with PR-A types regen.
      let q = supabase
        .from('booking')
        .select('created_via, type, status')
        .eq('client_id', clientId)
      if (area) q = q.eq('collection_area_id', area)
      const { data: rows } = await q
      // created_via is TYPE-GATED (resolves on PR-A types regen); rows are then
      // assignable to SelfServiceRow[] directly (no cast needed).
      return computeSelfServiceRate(rows ?? [])
    },
  })
  const r = data
  const value = !r ? '—' : r.isEmpty ? 'Tracking starts soon'
    : r.isLowN ? `${r.selfServed} / ${r.inScope}` : pct1(r.pct!)
  const sub = !r || r.isEmpty
    ? r && r.excludedLegacy > 0 ? `${r.excludedLegacy} earlier bookings excluded` : undefined
    : r.isLowN ? 'Building data' : `${r.selfServed} / ${r.inScope} resident-created`
  return (
    <SlaCard
      label="Self-Service Rate"
      isLoading={isLoading}
      value={value}
      sub={sub}
      tone="neutral"
      target="Target ≥ 80%"
    />
  )
}

// ── NOTIF — Notification Reliability (email only, no area filter, spec §3.7) ─
function NotifCard({ clientId }: CardScope) {
  const supabase = createClient()
  const { data, isLoading } = useQuery({
    queryKey: ['sla-notif', clientId],
    enabled: !!clientId,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from('notification_log')
        .select('delivery_status')
        .eq('client_id', clientId)
        .eq('channel', 'email')
        .not('delivery_status', 'is', null)
      return computeNotificationReliability((rows ?? []).map((r) => r.delivery_status))
    },
  })
  const r = data
  const value = !r ? '—' : r.isEmpty ? 'No tracked email'
    : r.isLowN ? `${r.positive} / ${r.tracked}` : pct1(r.pct!)
  const sub = !r || r.isEmpty ? 'Email only'
    : r.isLowN ? 'Building data' : `${r.positive} / ${r.tracked} delivered · email only`
  return (
    <SlaCard
      label="Notification Delivery"
      isLoading={isLoading}
      value={value}
      sub={sub}
      tone={r ? scorecardTone(r.pct, NOTIF_TARGET_PCT, r) : 'neutral'}
      target={`Target ≥ ${NOTIF_TARGET_PCT}%`}
    />
  )
}

// ── PENETRATION — Property Penetration (insight, spec §3.9, RPC) ─────────────
function PenetrationCard({ clientId, area }: CardScope) {
  const supabase = createClient()
  const { data, isLoading } = useQuery({
    queryKey: ['sla-penetration', clientId, area],
    enabled: !!clientId,
    queryFn: async () => {
      // TYPE-GATED: get_property_penetration RPC lands with PR-A types regen.
      const { data: rows } = await supabase.rpc('get_property_penetration', {
        p_client_id: clientId,
        p_area_id: area || undefined,
      })
      const row = (rows ?? [])[0] ?? { booked: 0, eligible: 0 }
      const { booked, eligible } = row as { booked: number; eligible: number }
      return { result: computePenetration({ booked: Number(booked), eligible: Number(eligible) }), booked: Number(booked) }
    },
  })
  const r = data?.result
  return (
    <SlaCard
      label="Property Penetration"
      isLoading={isLoading}
      value={!r ? '—' : r.display}
      sub={!r || r.isEmpty ? undefined : r.isLowN ? 'Building data' : 'of eligible properties'}
      tone="neutral"
    />
  )
}

// ── RS — Resident Satisfaction (insight, spec §3.10) ────────────────────────
function ResidentSatisfactionCard({ clientId, area }: CardScope) {
  const supabase = createClient()
  const { data, isLoading } = useQuery({
    queryKey: ['sla-rs', clientId, area],
    enabled: !!clientId,
    queryFn: async () => {
      // For "All Areas" drop the embed (avoids multi-FK fragility); booking_survey
      // has a single booking FK so the inner embed is safe when an area is set.
      const q = area
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
      const { data: rows } = await q
      return computeResidentSatisfaction((rows ?? []).map((r) => ({ responses: r.responses })))
    },
  })
  const r = data
  const value = !r ? '—' : r.isEmpty ? 'No responses yet'
    : r.isLowN ? `${r.good} / ${r.n}` : pct1(r.pct!)
  const sub = !r || r.isEmpty ? undefined
    : r.isLowN ? 'Building data' : `${r.good} / ${r.n} rated good · target ≥ ${RS_TARGET_PCT}%`
  return (
    <SlaCard label="Resident Satisfaction" isLoading={isLoading} value={value} sub={sub} tone="neutral" />
  )
}

// ── VOLMIX — Service Breakdown (insight, full-width, spec §3.8) ──────────────

/**
 * Fixed per-service bar colours, matching the admin dashboard's convention
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

function VolumeMixCard({ clientId, area }: CardScope) {
  const supabase = createClient()
  const { data, isLoading } = useQuery({
    queryKey: ['sla-volmix', clientId, area],
    enabled: !!clientId,
    queryFn: async () => {
      let q = supabase
        .from('booking')
        .select('booking_item(no_services, actual_services, is_extra, service!inner(name, waste_stream))')
        .eq('client_id', clientId)
        .not('status', 'in', '("Cancelled","Pending Payment")')
      if (area) q = q.eq('collection_area_id', area)
      const { data: rows } = await q
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
  return (
    <div className="mt-4 rounded-xl bg-white p-5 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Service Breakdown</p>
      {isLoading || !r ? (
        <p className="mt-1 text-body-sm text-gray-400">Loading…</p>
      ) : r.isEmpty ? (
        <p className="mt-1 text-body-sm text-gray-400">No collections match these filters.</p>
      ) : (
        <>
          <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">
            {r.totalCollections}
            <span className="ml-1 text-[11px] font-medium text-gray-400">collections (booked)</span>
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500">
            {r.freeUnits} included · {r.extraUnits} extra
          </p>
          {!r.isLowN && (
            <div className="mt-3 space-y-1">
              {r.byService.map((s, i) => (
                <div key={s.name} className="flex items-center gap-3">
                  <span className="w-40 truncate text-body-sm text-gray-600">{s.name}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(2, (s.qty / r.totalCollections) * 100)}%`,
                        backgroundColor:
                          SERVICE_COLORS[s.name] ??
                          SERVICE_COLOR_FALLBACK[i % SERVICE_COLOR_FALLBACK.length],
                      }}
                    />
                  </div>
                  <span className="w-10 text-right text-body-sm font-semibold text-gray-700">{s.qty}</span>
                </div>
              ))}
            </div>
          )}
          {r.isLowN && <p className="mt-2 text-[11px] text-gray-400">Building data</p>}
        </>
      )}
    </div>
  )
}

/** WA public-holiday dates (YYYY-MM-DD) for the SR first-response working-day window. */
async function fetchWaHolidays(supabase: ReturnType<typeof createClient>): Promise<string[]> {
  const { data } = await supabase.from('public_holiday').select('date').eq('jurisdiction', 'WA')
  return (data ?? []).map((h) => h.date)
}
