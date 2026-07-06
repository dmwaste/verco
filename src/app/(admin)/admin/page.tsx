import { createClient } from '@/lib/supabase/server'
import { format, formatDistanceToNow } from 'date-fns'
import Link from 'next/link'
import { effectiveCapacity, indexPoolDates } from '@/lib/capacity/effective-capacity'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { getTenantMudPropertyIds } from '@/lib/admin/mud-tenant-scope'
import { awstWeekRange } from '@/lib/date/awst-week'
import { OPEN_INVESTIGATION_STATUSES } from '@/lib/exceptions/status'
import { StatusBadge } from '@/components/status-badge'

/** Shared height for every half-width dashboard tile so all rows line up. */
const HALF_CARD = 'flex h-96 flex-col rounded-xl bg-white p-5 shadow-sm'

/** 5-star rating, or an em-dash when the response has no valid rating. */
function Stars({ value }: { value: number | null }) {
  if (value === null) return <span className="text-gray-300">—</span>
  return (
    <span className="inline-flex gap-0.5" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <svg key={s} width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
            fill={s <= value ? '#FF8C42' : '#E8E8E8'}
          />
        </svg>
      ))}
    </span>
  )
}

export default async function AdminDashboardPage() {
  const supabase = await createClient()

  // Public-SELECT tables (collection_date, collection_area, allocation_rules) are
  // RLS USING(true) — NOT tenant-scoped by RLS. Resolve the active admin client
  // and filter those queries explicitly, or they leak other tenants' data (e.g. a
  // Verge Valet client-admin seeing City of Kwinana collection dates). Booking-based
  // queries below stay RLS-scoped. Mirrors the collection-dates page pattern.
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  const now = new Date()
  // "This week" = the current AWST week (Mon–Sun) as calendar-date strings. Used
  // to scope the two "this week" widgets to collections whose collection_date
  // falls in this week — NOT booking.created_at. TZ-safe on the UTC prod
  // container (see awstWeekRange; the old startOfWeek(now) computed the UTC week).
  const { monday: weekMonday, sunday: weekSunday } = awstWeekRange(now)

  // Get current FY + the current tenant's MUD property ids in parallel. The MUD
  // reminder view (v_mud_next_expected) reads public-SELECT eligible_properties
  // and is NOT tenant-scoped by RLS, so it must be filtered by these ids in app
  // code or it leaks other tenants' MUDs (VER-280).
  const [{ data: fy }, tenantMudIds] = await Promise.all([
    supabase
      .from('financial_year')
      .select('id, label')
      .eq('is_current', true)
      .single(),
    getTenantMudPropertyIds(clientId),
  ])

  // Parallel data fetches. booking/service_ticket queries are RLS-scoped, but
  // contractor users can see ALL their clients via RLS — so the stat cards must
  // also be filtered to the active switcher client (clientId), else a contractor
  // admin sees every tenant's counts merged. collection_date is public-SELECT so
  // it is explicitly filtered by clientId via its area. Each .eq is guarded by
  // `if (clientId)` so the no-client fallback keeps the historical behaviour.
  // Count only the current FY — the card is labelled "FY total to date". Without
  // this the count silently becomes all-time (correct only while every booking
  // lives in the first FY; overstates from FY27 onward).
  const completedQuery = supabase
    .from('booking')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'Completed')
  if (fy) completedQuery.eq('fy_id', fy.id)
  // Exception cards count OPEN INVESTIGATIONS (notice records staff are actively
  // working — Disputed/Under Review), NOT bookings-by-status. The notice record
  // is the exception source of truth. See the NCN/NP investigations spec.
  const ncnQuery = supabase
    .from('non_conformance_notice')
    .select('id', { count: 'exact', head: true })
    .in('status', [...OPEN_INVESTIGATION_STATUSES])
  const npQuery = supabase
    .from('nothing_presented')
    .select('id', { count: 'exact', head: true })
    .in('status', [...OPEN_INVESTIGATION_STATUSES])
  const ticketsQuery = supabase
    .from('service_ticket')
    .select('id', { count: 'exact', head: true })
    .in('status', ['open', 'in_progress'])
  const openTicketsQuery = supabase
    .from('service_ticket')
    .select('id, display_id, subject, status, priority, created_at, contact!inner(full_name)')
    .in('status', ['open', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(5)
  // Open Investigations list — notice records in Disputed/Under Review, both types,
  // merged + sorted below. A booking embed gives ref/area/address for each row.
  const NOTICE_LIST_SELECT =
    `id, status, reported_at,
     booking:booking_id(id, ref, collection_area!inner(code),
       eligible_properties:property_id(formatted_address, address))`
  const openNcnListQuery = supabase
    .from('non_conformance_notice')
    .select(NOTICE_LIST_SELECT)
    .in('status', [...OPEN_INVESTIGATION_STATUSES])
    .order('reported_at', { ascending: false })
    .limit(6)
  const openNpListQuery = supabase
    .from('nothing_presented')
    .select(NOTICE_LIST_SELECT)
    .in('status', [...OPEN_INVESTIGATION_STATUSES])
    .order('reported_at', { ascending: false })
    .limit(6)
  // Invariant safety net: bookings sitting in an exception status. Cross-checked
  // against notice records below to warn if any exception lacks an investigation
  // record (a future legacy import bypassing closeout would re-break the tables).
  const exceptionBookingsQuery = supabase
    .from('booking')
    .select('id, status')
    .in('status', ['Non-conformance', 'Nothing Presented'])
  // Collection dates whose date falls in the current AWST week, scoped to the
  // active tenant's areas (collection_date is public-SELECT — RLS won't scope it).
  // These ids drive the two "this week" widgets via their bookings' items.
  const weekDatesQuery = supabase
    .from('collection_date')
    .select('id, collection_area!inner(client_id)')
    .gte('date', weekMonday)
    .lte('date', weekSunday)
    .eq('collection_area.client_id', clientId)
  if (clientId) {
    completedQuery.eq('client_id', clientId)
    ncnQuery.eq('client_id', clientId)
    npQuery.eq('client_id', clientId)
    ticketsQuery.eq('client_id', clientId)
    openTicketsQuery.eq('client_id', clientId)
    openNcnListQuery.eq('client_id', clientId)
    openNpListQuery.eq('client_id', clientId)
    exceptionBookingsQuery.eq('client_id', clientId)
  }

  // Recent submitted survey responses for the dashboard feed. booking_survey is
  // RLS-scoped to staff; the explicit client_id keeps a contractor-admin's feed
  // on the switcher tenant.
  const recentSurveysQuery = supabase
    .from('booking_survey')
    .select('id, submitted_at, responses, booking!inner(ref)')
    .not('submitted_at', 'is', null)
    .order('submitted_at', { ascending: false })
    .limit(20)
  if (clientId) recentSurveysQuery.eq('client_id', clientId)

  const [
    completedResult,
    ncnResult,
    npResult,
    ticketsResult,
    upcomingDatesResult,
    openTicketsResult,
    openNcnListResult,
    openNpListResult,
    exceptionBookingsResult,
    weekDatesResult,
    mudRemindersResult,
    recentSurveysResult,
  ] = await Promise.all([
    completedQuery,
    ncnQuery,
    npQuery,
    ticketsQuery,
    // Upcoming collection dates — ALL future dates (open AND closed) so staff can
    // spot closures at a glance, chronological. Rendered as a compact scrollable
    // list; a generous cap keeps the DOM sane, with "View all" for the full page.
    supabase
      .from('collection_date')
      .select(
        `id, date, is_open,
         bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
         anc_capacity_limit, anc_units_booked, anc_is_closed,
         id_capacity_limit, id_units_booked, id_is_closed,
         collection_area!inner(name, code, capacity_pool_id, client_id)`
      )
      .eq('collection_area.client_id', clientId)
      .gte('date', now.toISOString().split('T')[0])
      .order('date', { ascending: true })
      .limit(60),
    openTicketsQuery,
    openNcnListQuery,
    openNpListQuery,
    exceptionBookingsQuery,
    weekDatesQuery,
    // MUD reminders: Registered MUDs with next_expected_date <= 14 days from today
    // (or NULL — for new MUDs that haven't had a booking yet, surfacing them
    // gives admins a chance to schedule the first one).
    supabase
      .from('v_mud_next_expected')
      .select('property_id, collection_cadence, last_date, next_expected_date')
      .in('property_id', tenantMudIds)
      .order('next_expected_date', { ascending: true, nullsFirst: false })
      .limit(20),
    recentSurveysQuery,
  ])

  const openExceptions = (ncnResult.count ?? 0) + (npResult.count ?? 0)

  // Merge the two open-investigation lists (NCN + NP), newest first, cap 6.
  type OpenInvestigationRow = {
    id: string
    reported_at: string
    booking: {
      id: string
      ref: string
      collection_area: { code: string }
      eligible_properties: { formatted_address: string | null; address: string } | null
    } | null
  }
  const openInvestigations = [
    ...((openNcnListResult.data ?? []) as unknown as OpenInvestigationRow[]).map((r) => ({ ...r, type: 'NCN' as const })),
    ...((openNpListResult.data ?? []) as unknown as OpenInvestigationRow[]).map((r) => ({ ...r, type: 'NP' as const })),
  ]
    .sort((a, b) => (a.reported_at < b.reported_at ? 1 : -1))
    .slice(0, 6)

  // Record-less exception guard: any exception-status booking missing a notice
  // record. Backfill closes the current gap; this warns loudly if a future legacy
  // import re-breaks the invariant that every exception has a record.
  const exceptionBookings = exceptionBookingsResult.data ?? []
  let recordlessCount = 0
  if (exceptionBookings.length > 0) {
    const ncnIds = exceptionBookings.filter((b) => b.status === 'Non-conformance').map((b) => b.id)
    const npIds = exceptionBookings.filter((b) => b.status === 'Nothing Presented').map((b) => b.id)
    const [ncnHave, npHave] = await Promise.all([
      ncnIds.length
        ? supabase.from('non_conformance_notice').select('booking_id').in('booking_id', ncnIds)
        : Promise.resolve({ data: [] as { booking_id: string }[] }),
      npIds.length
        ? supabase.from('nothing_presented').select('booking_id').in('booking_id', npIds)
        : Promise.resolve({ data: [] as { booking_id: string }[] }),
    ])
    const haveSet = new Set(
      [...(ncnHave.data ?? []), ...(npHave.data ?? [])].map((r) => r.booking_id),
    )
    recordlessCount = exceptionBookings.filter((b) => !haveSet.has(b.id)).length
  }

  // ── "This week" widgets — bookings whose collection_date is in this AWST week ──
  // A booking has no date column; it is dated through booking_item.collection_date_id.
  // One booking can have several items, so dedupe to one status per booking.
  const weekDateIds = (weekDatesResult.data ?? []).map((d) => d.id)
  const weekBookingStatus = new Map<string, string>()
  if (weekDateIds.length) {
    const weekItemsQuery = supabase
      .from('booking_item')
      .select('booking_id, booking!inner(status, client_id)')
      .in('collection_date_id', weekDateIds)
    if (clientId) weekItemsQuery.eq('booking.client_id', clientId)
    const { data: weekItems } = await weekItemsQuery
    for (const it of weekItems ?? []) {
      const b = it.booking as unknown as { status: string }
      weekBookingStatus.set(it.booking_id, b.status)
    }
  }
  // Headline "Bookings This Week" excludes not-going-ahead bookings; the summary
  // breaks the same set out by outcome status.
  let bookingsThisWeek = 0
  let weekCompleted = 0
  let weekCancelled = 0
  let weekNcn = 0
  let weekNp = 0
  for (const status of weekBookingStatus.values()) {
    if (status !== 'Cancelled' && status !== 'Pending Payment') bookingsThisWeek++
    if (status === 'Completed') weekCompleted++
    else if (status === 'Cancelled') weekCancelled++
    else if (status === 'Non-conformance') weekNcn++
    else if (status === 'Nothing Presented') weekNp++
  }

  const upcomingDates = upcomingDatesResult.data ?? []
  const openTickets = openTicketsResult.data ?? []
  const recentSurveys = recentSurveysResult.data ?? []
  // Pull one 1..5 integer rating out of the opaque responses blob by key —
  // used for the three star columns (booking / collection / overall).
  const surveyRating = (responses: unknown, key: string): number | null => {
    if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) return null
    const raw = (responses as Record<string, unknown>)[key]
    if (typeof raw !== 'number' && typeof raw !== 'string') return null
    const n = Number(raw)
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null
  }

  // For any pool-member areas in the upcoming-dates list, fetch authoritative
  // pool counters — per-area `collection_date.*` stays at 0 by design for
  // pool members (see migration 20260513080000_capacity_pool).
  const upcomingPoolIds = Array.from(
    new Set(
      upcomingDates
        .map((d) => (d.collection_area as unknown as { capacity_pool_id: string | null }).capacity_pool_id)
        .filter((id): id is string => id !== null),
    ),
  )
  const upcomingDateIsos = upcomingDates.map((d) => d.date)
  const { data: upcomingPoolDates } = upcomingPoolIds.length
    ? await supabase
        .from('collection_date_pool')
        .select(
          `date,
           bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
           anc_capacity_limit, anc_units_booked, anc_is_closed,
           id_capacity_limit, id_units_booked, id_is_closed,
           capacity_pool_id`,
        )
        .in('capacity_pool_id', upcomingPoolIds)
        .in('date', upcomingDateIsos)
    : { data: [] }

  // Index pool dates by `${poolId}|${date}` for O(1) lookup per row.
  const poolDateByKey = new Map(
    (upcomingPoolDates ?? []).map((p) => [`${p.capacity_pool_id}|${p.date}`, p]),
  )

  // ── MUD reminder block — filter to due-soon (<= 14 days) and decorate ────
  const REMINDER_HORIZON_DAYS = 14
  const reminderHorizon = new Date(now.getTime() + REMINDER_HORIZON_DAYS * 24 * 60 * 60 * 1000)
  const dueSoonRows = (mudRemindersResult.data ?? []).filter((r) => {
    if (!r.next_expected_date) return false
    const d = new Date(r.next_expected_date + 'T00:00:00')
    return d <= reminderHorizon
  })

  // Brand-new Registered MUDs with no completed bookings — surface separately
  // so they don't get lost. The view returns them with last_date = null and
  // next_expected_date = null.
  const newRegisteredRows = (mudRemindersResult.data ?? []).filter(
    (r) => r.last_date === null && r.next_expected_date === null
  )

  // Fetch addresses + codes for everything we'll display
  const reminderPropertyIds = [...dueSoonRows, ...newRegisteredRows]
    .map((r) => r.property_id)
    .filter((id): id is string => id !== null)
  const { data: reminderProperties } = reminderPropertyIds.length
    ? await supabase
        .from('eligible_properties')
        .select('id, formatted_address, address, mud_code, unit_count')
        .in('id', reminderPropertyIds)
    : { data: [] }

  const propertyById = new Map(
    (reminderProperties ?? []).map((p) => [p.id, p])
  )

  type UpcomingDate = typeof upcomingDates[number]

  function getCapacityColor(booked: number, limit: number): string {
    const pct = limit > 0 ? booked / limit : 0
    if (pct >= 0.9) return 'bg-[#E53E3E]'
    if (pct >= 0.6) return 'bg-[#FF8C42]'
    return 'bg-[#00E47C]'
  }

  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Dashboard
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            {fy?.label ?? ''} &middot; {format(now, 'EEEE d MMMM yyyy')}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Link
            href="/book?on_behalf=true"
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-[#1e3040] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#293F52]/40"
          >
            + New Booking
          </Link>
        </div>
      </div>

      {/* Invariant guard: an exception-status booking with no notice record means
          a source (e.g. a legacy import) bypassed closeout — such rows silently
          drop out of the record-driven exception tables. Loud, actionable warning. */}
      {recordlessCount > 0 && (
        <div className="mx-7 mt-5 flex items-start gap-2.5 rounded-lg border border-status-warn/30 bg-status-warn-bg px-4 py-3 text-body-sm text-status-warn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>
            <strong>{recordlessCount}</strong> exception{recordlessCount === 1 ? '' : 's'} {recordlessCount === 1 ? 'is' : 'are'} missing an investigation record and won&rsquo;t appear in the exception tables. This usually means a legacy import set the status without a closeout — re-run the exception backfill reconciliation.
          </span>
        </div>
      )}

      {/* Stat cards — each links to its drill-down page (the numbers are
          summaries of queues staff act on, not decoration). */}
      <div className="grid grid-cols-2 gap-4 px-7 pt-5 xl:grid-cols-4">
        <Link href="/admin/bookings" className="block rounded-xl bg-white p-5 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#293F52]/40">
          <div className="mb-2.5 flex size-9 items-center justify-center rounded-[10px] bg-[#E8FDF0] text-[#00B864]">
            <svg width="20" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
          </div>
          <div className="mb-2 text-xs font-medium text-gray-500">Bookings This Week</div>
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
            {bookingsThisWeek}
          </div>
        </Link>

        <Link href="/admin/bookings?status=Completed" className="block rounded-xl bg-white p-5 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#293F52]/40">
          <div className="mb-2.5 flex size-9 items-center justify-center rounded-[10px] bg-[#E8EEF2] text-[#293F52]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div className="mb-2 text-xs font-medium text-gray-500">Collections Completed</div>
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
            {completedResult.count ?? 0}
          </div>
          <div className="mt-1 text-xs text-gray-500">FY total to date</div>
        </Link>

        <Link href="/admin/non-conformance" className="block rounded-xl bg-white p-5 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#293F52]/40">
          <div className="mb-2.5 flex size-9 items-center justify-center rounded-[10px] bg-[#FFF3EA] text-[#FF8C42]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <div className="mb-2 text-xs font-medium text-gray-500">Open Investigations</div>
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
            {openExceptions}
          </div>
          <div className={`mt-1 text-xs ${openExceptions > 0 ? 'text-status-error' : 'text-gray-500'}`}>
            {ncnResult.count ?? 0} NCN &middot; {npResult.count ?? 0} NP
          </div>
        </Link>

        <Link href="/admin/service-tickets" className="block rounded-xl bg-white p-5 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#293F52]/40">
          <div className="mb-2.5 flex size-9 items-center justify-center rounded-[10px] bg-[#FFF0F0] text-[#E53E3E]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </div>
          <div className="mb-2 text-xs font-medium text-gray-500">Open Tickets</div>
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
            {ticketsResult.count ?? 0}
          </div>
        </Link>
      </div>

      {/* Two-column grid */}
      <div className="grid grid-cols-1 gap-4 px-7 py-5 lg:grid-cols-2">
        {/* Upcoming collection dates — all future dates (open + closed), compact */}
        <div className={HALF_CARD}>
          <div className="mb-3.5 flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
              Upcoming Collection Dates
            </h2>
            <Link href="/admin/collection-dates" className="text-xs font-medium text-[#00B864] hover:underline">View all &rarr;</Link>
          </div>
          <div className="-mr-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
            {upcomingDates.map((d: UpcomingDate) => {
              const area = d.collection_area as unknown as { name: string; code: string; capacity_pool_id: string | null }
              const pool = area.capacity_pool_id
                ? poolDateByKey.get(`${area.capacity_pool_id}|${d.date}`) ?? null
                : null
              const cap = effectiveCapacity(d, area.capacity_pool_id, pool ? indexPoolDates([pool]) : new Map())
              const pctBulk = cap.bulk_capacity_limit > 0 ? (cap.bulk_units_booked / cap.bulk_capacity_limit) * 100 : 0
              return (
                <div key={d.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-gray-50">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-[#293F52]">
                      {format(new Date(d.date + 'T00:00:00'), 'EEE d MMM')}
                    </span>
                    <span className="truncate text-caption text-gray-500">{area.name}</span>
                  </div>
                  {d.is_open ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className={`h-full rounded-full ${getCapacityColor(cap.bulk_units_booked, cap.bulk_capacity_limit)}`}
                          style={{ width: `${Math.min(pctBulk, 100)}%` }}
                        />
                      </div>
                      <span className="w-10 text-right text-caption tabular-nums text-gray-500">
                        {cap.bulk_units_booked}/{cap.bulk_capacity_limit}
                      </span>
                    </div>
                  ) : (
                    <span className="shrink-0 rounded bg-status-error-bg px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-status-error">
                      Closed
                    </span>
                  )}
                </div>
              )
            })}
            {upcomingDates.length === 0 && (
              <p className="py-4 text-center text-sm text-gray-400">No upcoming dates</p>
            )}
          </div>
        </div>

        {/* Weekly summary — collections scheduled this week, by outcome. No
            list to scroll, so the 2×2 grid fills the shared card height. */}
        <div className={HALF_CARD}>
          <h2 className="mb-3.5 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
            This Week&apos;s Summary
          </h2>
          <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-2.5">
            {[
              { label: 'Completed', value: weekCompleted, color: 'text-[#00B864]' },
              { label: 'Cancelled', value: weekCancelled, color: 'text-[#FF8C42]' },
              { label: 'Non-Conformance', value: weekNcn, color: 'text-status-error' },
              { label: 'Nothing Presented', value: weekNp, color: 'text-[#FF8C42]' },
            ].map((stat) => (
              <div key={stat.label} className="flex flex-col justify-center rounded-lg bg-gray-50 px-3.5 py-3">
                <div className="mb-1 text-caption text-gray-500">{stat.label}</div>
                {/* Tone colour only when the count is non-zero — an orange or red
                    zero reads as an alarm for a state where nothing is wrong. */}
                <div className={`font-[family-name:var(--font-heading)] text-xl font-bold ${stat.value > 0 ? stat.color : 'text-[#293F52]'}`}>
                  {stat.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Open service tickets. Fixed height + scrollable body so the list
            never pushes the card taller than its siblings. */}
        <div className={HALF_CARD}>
          <div className="mb-3.5 flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
              Open Service Tickets
            </h2>
            <Link href="/admin/service-tickets" className="text-xs font-medium text-[#00B864] hover:underline">View all &rarr;</Link>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {openTickets.map((ticket) => {
            const contact = ticket.contact as unknown as { full_name: string }
            const initials = contact.full_name
              .split(' ')
              .map((n) => n[0])
              .join('')
              .toUpperCase()
              .slice(0, 2)
            return (
              <Link
                key={ticket.id}
                href={`/admin/service-tickets/${ticket.display_id}`}
                className="flex items-center gap-3 border-b border-gray-100 py-2.5 last:border-b-0 last:pb-0 hover:bg-gray-50"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#E8EEF2] text-xs font-semibold text-[#293F52]">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-body-sm font-medium text-gray-900">{contact.full_name}</div>
                  <div className="truncate text-xs text-gray-500">{ticket.subject}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge entity="ticketPriority" status={ticket.priority} />
                  <span className="text-caption text-gray-500">
                    {formatDistanceToNow(new Date(ticket.created_at), { addSuffix: false })}
                  </span>
                </div>
              </Link>
            )
          })}
          {openTickets.length === 0 && (
            <p className="flex flex-1 items-center justify-center py-8 text-sm text-gray-400">No open tickets</p>
          )}
          </div>
        </div>

        {/* Recent survey feedback — newest 20 submitted responses as a compact
            table with a sticky column header; each row's Ref links to the
            survey detail. Shows the three star ratings per submission. */}
        <div className={HALF_CARD}>
          <div className="mb-3.5 flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
              Recent Survey Feedback
            </h2>
            <Link href="/admin/surveys" className="text-xs font-medium text-[#00B864] hover:underline">View all &rarr;</Link>
          </div>
          {recentSurveys.length === 0 ? (
            <p className="flex flex-1 items-center justify-center py-8 text-center text-sm text-gray-400">
              No responses yet — surveys are emailed after each collection is completed
            </p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <table className="w-full">
                {/* Sticky header keeps the column labels pinned while the 20
                    rows scroll beneath. */}
                <thead className="sticky top-0 z-10 bg-white">
                  <tr className="border-b border-gray-100 text-caption text-gray-500">
                    <th className="py-1.5 pr-2 text-left font-medium">Ref</th>
                    <th className="px-1 py-1.5 text-center font-medium">Booking</th>
                    <th className="px-1 py-1.5 text-center font-medium">Collection</th>
                    <th className="px-1 py-1.5 text-center font-medium">Overall</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSurveys.map((s) => {
                    const booking = s.booking as unknown as { ref: string }
                    return (
                      <tr key={s.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                        <td className="py-2 pr-2">
                          <Link
                            href={`/admin/surveys/${s.id}`}
                            className="text-body-sm font-medium text-[#293F52] hover:underline"
                          >
                            {booking.ref}
                          </Link>
                        </td>
                        <td className="px-1 py-2 text-center">
                          <div className="flex justify-center"><Stars value={surveyRating(s.responses, 'booking_rating')} /></div>
                        </td>
                        <td className="px-1 py-2 text-center">
                          <div className="flex justify-center"><Stars value={surveyRating(s.responses, 'collection_rating')} /></div>
                        </td>
                        <td className="px-1 py-2 text-center">
                          <div className="flex justify-center"><Stars value={surveyRating(s.responses, 'overall_rating')} /></div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Open Investigations — notice records staff are actively working
            (Disputed/Under Review), both types, newest first. Rows link to the
            booking detail. Reads 0 when nothing is under investigation. */}
        <div className={HALF_CARD}>
          <div className="mb-3.5 flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
              Open Investigations
            </h2>
            <span className="flex items-center gap-3">
              <Link href="/admin/non-conformance" className="text-xs font-medium text-[#00B864] hover:underline">NCNs &rarr;</Link>
              <Link href="/admin/nothing-presented" className="text-xs font-medium text-[#00B864] hover:underline">NPs &rarr;</Link>
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {openInvestigations.map((r) => {
            const isNcn = r.type === 'NCN'
            const property = r.booking?.eligible_properties ?? null
            const area = r.booking?.collection_area
            const address = property?.formatted_address ?? property?.address ?? r.booking?.ref ?? '—'
            return (
              <Link
                key={`${r.type}-${r.id}`}
                href={r.booking ? `/admin/bookings/${r.booking.id}` : `/admin/${isNcn ? 'non-conformance' : 'nothing-presented'}/${r.id}`}
                className="flex items-center gap-3 border-b border-gray-100 py-2.5 last:border-b-0 last:pb-0 hover:bg-gray-50"
              >
                <div
                  className={`flex h-8 w-11 shrink-0 items-center justify-center rounded-lg text-2xs font-bold ${
                    isNcn ? 'bg-status-error-bg text-status-error' : 'bg-status-warn-bg text-status-warn'
                  }`}
                >
                  {r.type}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body-sm font-medium text-gray-900">{address}</div>
                  <div className="text-xs text-gray-500">{r.booking?.ref ?? '—'} &middot; {area?.code ?? '—'}</div>
                </div>
                <span className="shrink-0 text-caption text-gray-500">
                  {formatDistanceToNow(new Date(r.reported_at), { addSuffix: false })}
                </span>
              </Link>
            )
          })}
          {openInvestigations.length === 0 && (
            <p className="flex flex-1 items-center justify-center py-8 text-sm text-gray-400">No open investigations</p>
          )}
          </div>
        </div>

        {/* MUD reminders — half width to match the other dashboard tiles */}
        <div className={HALF_CARD}>
          <div className="mb-3.5 flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
              MUDs Due Soon
              <span className="ml-2 text-caption font-normal text-gray-500">
                Next 14 days · cadence-based
              </span>
            </h2>
            <Link
              href="/admin/properties?mud=mud"
              className="text-xs font-medium text-[#00B864] hover:underline"
            >
              All MUDs &rarr;
            </Link>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
          {dueSoonRows.length === 0 && newRegisteredRows.length === 0 ? (
            <p className="flex h-full items-center justify-center py-4 text-center text-sm text-gray-400">
              No MUDs due in the next 14 days.
            </p>
          ) : (
            <div className="space-y-1">
              {dueSoonRows.map((r) => {
                if (!r.property_id) return null
                const p = propertyById.get(r.property_id)
                if (!p) return null
                return (
                  <Link
                    key={r.property_id}
                    href={`/admin/properties/${r.property_id}`}
                    className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-gray-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body-sm font-medium text-[#293F52]">
                        {p.formatted_address ?? p.address}
                      </div>
                      <div className="mt-0.5 text-caption text-gray-500">
                        {p.mud_code ?? 'MUD'} · {p.unit_count}u · {r.collection_cadence}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs font-semibold text-[#293F52]">
                        {r.next_expected_date
                          ? format(new Date(r.next_expected_date + 'T00:00:00'), 'd MMM')
                          : '—'}
                      </div>
                      <div className="mt-0.5 text-caption text-gray-500">
                        last {r.last_date
                          ? format(new Date(r.last_date + 'T00:00:00'), 'd MMM yyyy')
                          : 'never'}
                      </div>
                    </div>
                  </Link>
                )
              })}
              {newRegisteredRows.length > 0 && (
                <div className="mt-3 border-t border-gray-100 pt-3">
                  <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-gray-500">
                    New Registered (no bookings yet)
                  </div>
                  {newRegisteredRows.map((r) => {
                    if (!r.property_id) return null
                    const p = propertyById.get(r.property_id)
                    if (!p) return null
                    return (
                      <Link
                        key={r.property_id}
                        href={`/admin/properties/${r.property_id}`}
                        className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-gray-50"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-body-sm font-medium text-[#293F52]">
                            {p.formatted_address ?? p.address}
                          </div>
                          <div className="mt-0.5 text-caption text-gray-500">
                            {p.mud_code ?? 'MUD'} · {p.unit_count}u · {r.collection_cadence}
                          </div>
                        </div>
                        <div className="shrink-0 text-caption text-amber-600">
                          Schedule first booking
                        </div>
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          </div>
        </div>

      </div>
    </>
  )
}
