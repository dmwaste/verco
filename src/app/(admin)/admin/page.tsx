import { createClient } from '@/lib/supabase/server'
import { format, startOfWeek, endOfWeek, formatDistanceToNow } from 'date-fns'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import Link from 'next/link'
import { effectiveCapacity, indexPoolDates } from '@/lib/capacity/effective-capacity'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { getTenantMudPropertyIds } from '@/lib/admin/mud-tenant-scope'

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
  const weekStart = startOfWeek(now, { weekStartsOn: 1 }).toISOString()
  const weekEnd = endOfWeek(now, { weekStartsOn: 1 }).toISOString()

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
  const weekBookingsQuery = supabase
    .from('booking')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', weekStart)
    .lte('created_at', weekEnd)
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
  const weeklySubmittedQuery = supabase.from('booking').select('id', { count: 'exact', head: true }).eq('status', 'Submitted').gte('created_at', weekStart).lte('created_at', weekEnd)
  const weeklyConfirmedQuery = supabase.from('booking').select('id', { count: 'exact', head: true }).eq('status', 'Confirmed').gte('created_at', weekStart).lte('created_at', weekEnd)
  const weeklyCompletedQuery = supabase.from('booking').select('id', { count: 'exact', head: true }).eq('status', 'Completed').gte('created_at', weekStart).lte('created_at', weekEnd)
  const weeklyCancelledQuery = supabase.from('booking').select('id', { count: 'exact', head: true }).eq('status', 'Cancelled').gte('created_at', weekStart).lte('created_at', weekEnd)
  const weeklyNcnQuery = supabase.from('booking').select('id', { count: 'exact', head: true }).eq('status', 'Non-conformance').gte('created_at', weekStart).lte('created_at', weekEnd)
  const weeklyNpQuery = supabase.from('booking').select('id', { count: 'exact', head: true }).eq('status', 'Nothing Presented').gte('created_at', weekStart).lte('created_at', weekEnd)
  const openTicketsQuery = supabase
    .from('service_ticket')
    .select('id, display_id, subject, status, priority, created_at, contact!inner(full_name)')
    .in('status', ['open', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(5)
  if (clientId) {
    weekBookingsQuery.eq('client_id', clientId)
    completedQuery.eq('client_id', clientId)
    ncnQuery.eq('client_id', clientId)
    npQuery.eq('client_id', clientId)
    ticketsQuery.eq('client_id', clientId)
    weeklySubmittedQuery.eq('client_id', clientId)
    weeklyConfirmedQuery.eq('client_id', clientId)
    weeklyCompletedQuery.eq('client_id', clientId)
    weeklyCancelledQuery.eq('client_id', clientId)
    weeklyNcnQuery.eq('client_id', clientId)
    weeklyNpQuery.eq('client_id', clientId)
    openTicketsQuery.eq('client_id', clientId)
  }

  const [
    weekBookingsResult,
    completedResult,
    ncnResult,
    npResult,
    ticketsResult,
    upcomingDatesResult,
    weeklySubmitted,
    weeklyConfirmed,
    weeklyCompleted,
    weeklyCancelled,
    weeklyNcn,
    weeklyNp,
    openTicketsResult,
    mudRemindersResult,
  ] = await Promise.all([
    weekBookingsQuery,
    completedQuery,
    ncnQuery,
    npQuery,
    ticketsQuery,
    supabase
      .from('collection_date')
      .select(
        `id, date,
         bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
         anc_capacity_limit, anc_units_booked, anc_is_closed,
         id_capacity_limit, id_units_booked, id_is_closed,
         collection_area!inner(name, code, capacity_pool_id, client_id)`
      )
      .eq('is_open', true)
      .eq('collection_area.client_id', clientId)
      .gte('date', now.toISOString().split('T')[0])
      .order('date', { ascending: true })
      .limit(5),
    weeklySubmittedQuery,
    weeklyConfirmedQuery,
    weeklyCompletedQuery,
    weeklyCancelledQuery,
    weeklyNcnQuery,
    weeklyNpQuery,
    openTicketsQuery,
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

  // FY allocation consumption — aggregate booking items by service type. Scope to
  // the active client via the booking embed so a contractor admin's consumption
  // bars reflect only the selected tenant (booking_item has no client_id of its own).
  let fyItemsQuery = fy
    ? supabase
        .from('booking_item')
        .select('no_services, service!inner(name, category!inner(name, code)), booking!inner(fy_id, status, client_id)')
        .eq('booking.fy_id', fy.id)
        .not('booking.status', 'in', '("Cancelled","Pending Payment")')
    : null
  if (fyItemsQuery && clientId) {
    fyItemsQuery = fyItemsQuery.eq('booking.client_id', clientId)
  }
  const { data: fyItems } = fyItemsQuery ? await fyItemsQuery : { data: null }

  // Sum by service type name
  const serviceUsage = new Map<string, number>()
  if (fyItems) {
    for (const item of fyItems) {
      const st = item.service as unknown as { name: string; category: { name: string; code: string } }
      serviceUsage.set(st.name, (serviceUsage.get(st.name) ?? 0) + item.no_services)
    }
  }

  const generalCount = serviceUsage.get('General') ?? 0
  const greenCount = serviceUsage.get('Green') ?? 0
  const mattressCount = serviceUsage.get('Mattress') ?? 0
  const ewasteCount = serviceUsage.get('E-Waste') ?? 0
  const whitegoodsCount = serviceUsage.get('Whitegoods') ?? 0
  const bulkTotal = generalCount + greenCount
  const ancTotal = mattressCount + ewasteCount + whitegoodsCount

  // Get total allocation maximums from allocation rules. allocation_rules is
  // public-SELECT (RLS USING(true)) — scope to the active client via its area,
  // else the Max denominator sums other tenants' rules and skews consumption %.
  const { data: allocRules } = await supabase
    .from('allocation_rules')
    .select('max_collections, category!inner(code), collection_area!inner(client_id)')
    .eq('collection_area.client_id', clientId)

  let bulkMax = 0
  let ancMax = 0
  if (allocRules) {
    for (const rule of allocRules) {
      const cat = rule.category as unknown as { code: string }
      if (cat.code === 'bulk') bulkMax += rule.max_collections
      else if (cat.code === 'anc') ancMax += rule.max_collections
    }
  }
  if (bulkMax === 0) bulkMax = 1
  if (ancMax === 0) ancMax = 1

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
            {weekBookingsResult.count ?? 0}
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
        {/* Upcoming collection dates */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-3.5 flex items-center justify-between font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
            Upcoming Collection Dates
            <Link href="/admin/collection-dates" className="text-xs font-medium text-[#00B864]">View all &rarr;</Link>
          </div>
          {upcomingDates.map((d: UpcomingDate) => {
            const area = d.collection_area as unknown as { name: string; code: string; capacity_pool_id: string | null }
            const pool = area.capacity_pool_id
              ? poolDateByKey.get(`${area.capacity_pool_id}|${d.date}`) ?? null
              : null
            const cap = effectiveCapacity(d, area.capacity_pool_id, pool ? indexPoolDates([pool]) : new Map())
            const pctBulk = cap.bulk_capacity_limit > 0 ? (cap.bulk_units_booked / cap.bulk_capacity_limit) * 100 : 0
            return (
              <div key={d.id} className="flex items-center justify-between border-b border-gray-100 py-2.5 last:border-b-0 last:pb-0">
                <div>
                  <div className="text-body-sm font-medium text-[#293F52]">
                    {format(new Date(d.date + 'T00:00:00'), 'EEE d MMMM yyyy')}
                  </div>
                  <div className="text-[11px] text-gray-500">{area.name}</div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-gray-100">
                    <div
                      className={`h-full rounded-full ${getCapacityColor(cap.bulk_units_booked, cap.bulk_capacity_limit)}`}
                      style={{ width: `${Math.min(pctBulk, 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500">
                    {cap.bulk_units_booked}/{cap.bulk_capacity_limit}
                  </span>
                </div>
              </div>
            )
          })}
          {upcomingDates.length === 0 && (
            <p className="py-4 text-center text-sm text-gray-400">No upcoming dates</p>
          )}
        </div>

        {/* Weekly summary */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-3.5 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
            This Week&apos;s Summary
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {[
              { label: 'Submitted', value: weeklySubmitted.count ?? 0 },
              { label: 'Confirmed', value: weeklyConfirmed.count ?? 0, color: 'text-[#00B864]' },
              { label: 'Completed', value: weeklyCompleted.count ?? 0, color: 'text-[#00B864]' },
              { label: 'Cancelled', value: weeklyCancelled.count ?? 0, color: 'text-[#FF8C42]' },
              { label: 'Non-Conformance', value: weeklyNcn.count ?? 0, color: 'text-[#E53E3E]' },
              { label: 'Nothing Presented', value: weeklyNp.count ?? 0, color: 'text-[#FF8C42]' },
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

        {/* FY allocation consumption */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-3.5 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
            {fy?.label ?? 'FY'} Allocation Consumption
          </div>
          <div className="flex flex-col gap-5">
            {/* Bulk */}
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-body-sm font-semibold text-[#293F52]">Bulk</span>
                <span className="text-[11px] text-gray-500">{bulkTotal} / {bulkMax} used</span>
              </div>
              <div className="flex h-3.5 overflow-hidden rounded-full bg-gray-100">
                <div className="h-full bg-[#00E47C]" style={{ width: `${(generalCount / bulkMax) * 100}%` }} title={`General: ${generalCount}`} />
                <div className="h-full bg-[#00B864]" style={{ width: `${(greenCount / bulkMax) * 100}%` }} title={`Green: ${greenCount}`} />
              </div>
              <div className="mt-2 flex gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="size-2.5 shrink-0 rounded-sm bg-[#00E47C]" />
                  <span className="text-[11px] text-gray-700">General</span>
                  <span className="text-[11px] text-gray-500">{generalCount}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="size-2.5 shrink-0 rounded-sm bg-[#00B864]" />
                  <span className="text-[11px] text-gray-700">Green</span>
                  <span className="text-[11px] text-gray-500">{greenCount}</span>
                </div>
                <span className="ml-auto text-[11px] text-gray-400">Max {bulkMax}</span>
              </div>
            </div>

            <div className="h-px bg-gray-100" />

            {/* Ancillary */}
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-body-sm font-semibold text-[#293F52]">Ancillary</span>
                <span className="text-[11px] text-gray-500">{ancTotal} / {ancMax} used</span>
              </div>
              <div className="flex h-3.5 overflow-hidden rounded-full bg-gray-100">
                <div className="h-full bg-[#8FA5B8]" style={{ width: `${(mattressCount / ancMax) * 100}%` }} title={`Mattress: ${mattressCount}`} />
                <div className="h-full bg-[#FF8C42]" style={{ width: `${(ewasteCount / ancMax) * 100}%` }} title={`E-Waste: ${ewasteCount}`} />
                <div className="h-full bg-[#3A5A73]" style={{ width: `${(whitegoodsCount / ancMax) * 100}%` }} title={`Whitegoods: ${whitegoodsCount}`} />
              </div>
              <div className="mt-2 flex gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="size-2.5 shrink-0 rounded-sm bg-[#8FA5B8]" />
                  <span className="text-[11px] text-gray-700">Mattress</span>
                  <span className="text-[11px] text-gray-500">{mattressCount}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="size-2.5 shrink-0 rounded-sm bg-[#FF8C42]" />
                  <span className="text-[11px] text-gray-700">E-Waste</span>
                  <span className="text-[11px] text-gray-500">{ewasteCount}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="size-2.5 shrink-0 rounded-sm bg-[#3A5A73]" />
                  <span className="text-[11px] text-gray-700">Whitegoods</span>
                  <span className="text-[11px] text-gray-500">{whitegoodsCount}</span>
                </div>
                <span className="ml-auto text-[11px] text-gray-400">Max {ancMax}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
