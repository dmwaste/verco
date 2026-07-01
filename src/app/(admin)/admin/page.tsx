import { createClient } from '@/lib/supabase/server'
import { format, formatDistanceToNow } from 'date-fns'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import Link from 'next/link'
import { effectiveCapacity, indexPoolDates } from '@/lib/capacity/effective-capacity'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { getTenantMudPropertyIds } from '@/lib/admin/mud-tenant-scope'
import { awstWeekRange } from '@/lib/date/awst-week'

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
  const completedQuery = supabase
    .from('booking')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'Completed')
  const ncnQuery = supabase
    .from('booking')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'Non-conformance')
  const npQuery = supabase
    .from('booking')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'Nothing Presented')
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
  }

  const [
    completedResult,
    ncnResult,
    npResult,
    ticketsResult,
    upcomingDatesResult,
    openTicketsResult,
    weekDatesResult,
    ancServicesResult,
    mudRemindersResult,
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
    weekDatesQuery,
    // Ancillary service names (category "anc") — drives the allocation legend so it
    // always reflects the real current services and never silently zeroes on a
    // rename (service is public-SELECT / global; not tenant-specific).
    supabase.from('service').select('name, category!inner(code)').eq('category.code', 'anc'),
    // MUD reminders: Registered MUDs with next_expected_date <= 14 days from today
    // (or NULL — for new MUDs that haven't had a booking yet, surfacing them
    // gives admins a chance to schedule the first one).
    supabase
      .from('v_mud_next_expected')
      .select('property_id, collection_cadence, last_date, next_expected_date')
      .in('property_id', tenantMudIds)
      .order('next_expected_date', { ascending: true, nullsFirst: false })
      .limit(20),
  ])

  const openExceptions = (ncnResult.count ?? 0) + (npResult.count ?? 0)

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

  // FY collection totals — aggregate booking items for the current FY. Scope to the
  // active client via the booking embed (booking_item has no client_id). Keyed off
  // category.code + service.waste_stream (stable) rather than display names, which
  // drift on rename — e.g. "General"/"Green" → "Bulk Waste"/"Green Waste" silently
  // zeroed the old bar.
  let fyItemsQuery = fy
    ? supabase
        .from('booking_item')
        .select('no_services, service!inner(name, waste_stream, category!inner(code)), booking!inner(fy_id, status, client_id)')
        .eq('booking.fy_id', fy.id)
        .not('booking.status', 'in', '("Cancelled","Pending Payment")')
    : null
  if (fyItemsQuery && clientId) {
    fyItemsQuery = fyItemsQuery.eq('booking.client_id', clientId)
  }
  const { data: fyItems } = fyItemsQuery ? await fyItemsQuery : { data: null }

  // Collection (category "bulk"): split Bulk (general stream) vs Green.
  // Ancillary (category "anc"): split by service name (the 3 types share a stream).
  let bulkWasteCount = 0
  let greenWasteCount = 0
  const ancByService = new Map<string, number>()
  for (const item of fyItems ?? []) {
    const s = item.service as unknown as {
      name: string
      waste_stream: string
      category: { code: string }
    }
    const n = item.no_services
    if (s.category.code === 'bulk') {
      if (s.waste_stream === 'green') greenWasteCount += n
      else bulkWasteCount += n
    } else if (s.category.code === 'anc') {
      ancByService.set(s.name, (ancByService.get(s.name) ?? 0) + n)
    }
  }
  const collectionTotal = bulkWasteCount + greenWasteCount
  const ancTotal = [...ancByService.values()].reduce((sum, n) => sum + n, 0)

  // Legend for the Ancillary card: the real current anc services (alphabetical),
  // each with its FY count. Fixed colours for the known three; a stable fallback
  // palette keeps any newly-added service visible.
  const ANC_COLORS: Record<string, string> = {
    Mattress: '#8FA5B8',
    'E-Waste': '#FF8C42',
    Whitegoods: '#3A5A73',
  }
  const ANC_FALLBACK = ['#6B8299', '#B0763A', '#26506B', '#93A7B8']
  const ancServices = (ancServicesResult.data ?? [])
    .map((s) => s.name)
    .sort()
    .map((name, i) => ({
      name,
      count: ancByService.get(name) ?? 0,
      color: ANC_COLORS[name] ?? ANC_FALLBACK[i % ANC_FALLBACK.length],
    }))

  const upcomingDates = upcomingDatesResult.data ?? []
  const openTickets = openTicketsResult.data ?? []

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
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white"
          >
            + New Booking
          </Link>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-4 px-7 pt-5">
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-2.5 flex size-9 items-center justify-center rounded-[10px] bg-[#E8FDF0] text-[#00B864]">
            <svg width="20" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
          </div>
          <div className="mb-2 text-xs font-medium text-gray-500">Bookings This Week</div>
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
            {bookingsThisWeek}
          </div>
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-2.5 flex size-9 items-center justify-center rounded-[10px] bg-[#E8EEF2] text-[#293F52]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div className="mb-2 text-xs font-medium text-gray-500">Collections Completed</div>
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
            {completedResult.count ?? 0}
          </div>
          <div className="mt-1 text-xs text-gray-500">FY total to date</div>
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-2.5 flex size-9 items-center justify-center rounded-[10px] bg-[#FFF3EA] text-[#FF8C42]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <div className="mb-2 text-xs font-medium text-gray-500">Open Exceptions</div>
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
            {openExceptions}
          </div>
          <div className="mt-1 text-xs text-[#E53E3E]">
            {ncnResult.count ?? 0} NCN &middot; {npResult.count ?? 0} NP
          </div>
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-2.5 flex size-9 items-center justify-center rounded-[10px] bg-[#FFF0F0] text-[#E53E3E]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </div>
          <div className="mb-2 text-xs font-medium text-gray-500">Open Tickets</div>
          <div className="font-[family-name:var(--font-heading)] text-display font-bold text-[#293F52]">
            {ticketsResult.count ?? 0}
          </div>
        </div>
      </div>

      {/* Two-column grid */}
      <div className="grid grid-cols-2 gap-4 px-7 py-5">
        {/* Upcoming collection dates — all future dates (open + closed), compact */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
            Upcoming Collection Dates
            <Link href="/admin/collection-dates" className="text-xs font-medium text-[#00B864]">View all &rarr;</Link>
          </div>
          <div className="-mr-1 max-h-80 space-y-0.5 overflow-y-auto pr-1">
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
                    <span className="shrink-0 text-[12px] font-semibold tabular-nums text-[#293F52]">
                      {format(new Date(d.date + 'T00:00:00'), 'EEE d MMM')}
                    </span>
                    <span className="truncate text-[11px] text-gray-500">{area.name}</span>
                  </div>
                  {d.is_open ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className={`h-full rounded-full ${getCapacityColor(cap.bulk_units_booked, cap.bulk_capacity_limit)}`}
                          style={{ width: `${Math.min(pctBulk, 100)}%` }}
                        />
                      </div>
                      <span className="w-10 text-right text-[11px] tabular-nums text-gray-500">
                        {cap.bulk_units_booked}/{cap.bulk_capacity_limit}
                      </span>
                    </div>
                  ) : (
                    <span className="shrink-0 rounded bg-[#FFF0F0] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#E53E3E]">
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

        {/* Weekly summary — collections scheduled this week, by outcome */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-3.5 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
            This Week&apos;s Summary
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {[
              { label: 'Completed', value: weekCompleted, color: 'text-[#00B864]' },
              { label: 'Cancelled', value: weekCancelled, color: 'text-[#FF8C42]' },
              { label: 'Non-Conformance', value: weekNcn, color: 'text-[#E53E3E]' },
              { label: 'Nothing Presented', value: weekNp, color: 'text-[#FF8C42]' },
            ].map((stat) => (
              <div key={stat.label} className="rounded-lg bg-gray-50 px-3.5 py-3">
                <div className="mb-1 text-[11px] text-gray-500">{stat.label}</div>
                <div className={`font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52] ${stat.color ?? ''}`}>
                  {stat.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Open service tickets */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-3.5 flex items-center justify-between font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
            Open Service Tickets
            <Link href="/admin/service-tickets" className="text-xs font-medium text-[#00B864]">View all &rarr;</Link>
          </div>
          {openTickets.map((ticket) => {
            const contact = ticket.contact as unknown as { full_name: string }
            const initials = contact.full_name
              .split(' ')
              .map((n) => n[0])
              .join('')
              .toUpperCase()
              .slice(0, 2)
            return (
              <div key={ticket.id} className="flex items-center gap-3 border-b border-gray-100 py-2.5 last:border-b-0 last:pb-0">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#E8EEF2] text-xs font-semibold text-[#293F52]">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-body-sm font-medium text-gray-900">{contact.full_name}</div>
                  <div className="truncate text-xs text-gray-500">{ticket.subject}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <BookingStatusBadge
                    status={ticket.priority === 'high' || ticket.priority === 'urgent' ? 'Nothing Presented' : 'Submitted'}
                    className={
                      ticket.priority === 'high' || ticket.priority === 'urgent'
                        ? 'bg-[#FFF3EA] text-[#C05A00]'
                        : 'bg-[#EBF5FF] text-[#3182CE]'
                    }
                  />
                  <span className="text-[11px] text-gray-300">
                    {formatDistanceToNow(new Date(ticket.created_at), { addSuffix: false })}
                  </span>
                </div>
              </div>
            )
          })}
          {openTickets.length === 0 && (
            <p className="py-4 text-center text-sm text-gray-400">No open tickets</p>
          )}
        </div>

        {/* MUD reminders — half width to match the other dashboard tiles */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-3.5 flex items-center justify-between font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
            <span>
              MUDs Due Soon
              <span className="ml-2 text-[11px] font-normal text-gray-400">
                Next 14 days · cadence-based
              </span>
            </span>
            <Link
              href="/admin/properties?mud=mud"
              className="text-xs font-medium text-[#00B864]"
            >
              All MUDs &rarr;
            </Link>
          </div>
          {dueSoonRows.length === 0 && newRegisteredRows.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-400">
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
                    className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-gray-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-[#293F52]">
                        {p.formatted_address ?? p.address}
                      </div>
                      <div className="mt-0.5 text-[11px] text-gray-500">
                        {p.mud_code ?? 'MUD'} · {p.unit_count}u · {r.collection_cadence}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[12px] font-semibold text-[#293F52]">
                        {r.next_expected_date
                          ? format(new Date(r.next_expected_date + 'T00:00:00'), 'd MMM')
                          : '—'}
                      </div>
                      <div className="mt-0.5 text-[10px] text-gray-400">
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
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
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
                        className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-gray-50"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-[#293F52]">
                            {p.formatted_address ?? p.address}
                          </div>
                          <div className="mt-0.5 text-[11px] text-gray-500">
                            {p.mud_code ?? 'MUD'} · {p.unit_count}u · {r.collection_cadence}
                          </div>
                        </div>
                        <div className="shrink-0 text-[11px] text-amber-600">
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

        {/* FY collection totals */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-3.5 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
            {fy?.label ?? 'FY'} Collections
            <span className="ml-2 text-[11px] font-normal text-gray-400">FY to date</span>
          </div>
          <div className="flex flex-col gap-5">
            {/* Collection — Bulk + Green */}
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-body-sm font-semibold text-[#293F52]">Collection</span>
                <span className="text-[11px] text-gray-500">{collectionTotal} collections</span>
              </div>
              <div className="flex h-3.5 overflow-hidden rounded-full bg-gray-100">
                <div className="h-full bg-[#00E47C]" style={{ width: `${collectionTotal > 0 ? (bulkWasteCount / collectionTotal) * 100 : 0}%` }} title={`Bulk: ${bulkWasteCount}`} />
                <div className="h-full bg-[#00B864]" style={{ width: `${collectionTotal > 0 ? (greenWasteCount / collectionTotal) * 100 : 0}%` }} title={`Green: ${greenWasteCount}`} />
              </div>
              <div className="mt-2 flex gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="size-2.5 shrink-0 rounded-sm bg-[#00E47C]" />
                  <span className="text-[11px] text-gray-700">Bulk</span>
                  <span className="text-[11px] text-gray-500">{bulkWasteCount}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="size-2.5 shrink-0 rounded-sm bg-[#00B864]" />
                  <span className="text-[11px] text-gray-700">Green</span>
                  <span className="text-[11px] text-gray-500">{greenWasteCount}</span>
                </div>
              </div>
            </div>

            <div className="h-px bg-gray-100" />

            {/* Ancillary — service-type breakdown */}
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-body-sm font-semibold text-[#293F52]">Ancillary</span>
                <span className="text-[11px] text-gray-500">{ancTotal} collections</span>
              </div>
              <div className="flex h-3.5 overflow-hidden rounded-full bg-gray-100">
                {ancServices.map((s) => (
                  <div
                    key={s.name}
                    className="h-full"
                    style={{ width: `${ancTotal > 0 ? (s.count / ancTotal) * 100 : 0}%`, backgroundColor: s.color }}
                    title={`${s.name}: ${s.count}`}
                  />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                {ancServices.map((s) => (
                  <div key={s.name} className="flex items-center gap-1.5">
                    <div className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
                    <span className="text-[11px] text-gray-700">{s.name}</span>
                    <span className="text-[11px] text-gray-500">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
