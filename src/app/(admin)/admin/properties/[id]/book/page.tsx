import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { checkMudAllowance } from '@/lib/mud/allowance'
import { MUD_UNITS_PER_SERVICE } from '@/lib/mud/capacity'
import { effectiveCapacity, indexPoolDates } from '@/lib/capacity/effective-capacity'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { MudBookingForm, type ServiceOption, type DateOption } from './mud-booking-form'

interface MudBookingPageProps {
  params: Promise<{ id: string }>
}

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000

export default async function MudBookingPage({ params }: MudBookingPageProps) {
  const { id } = await params
  const supabase = await createClient()

  // Tenant-scope the property fetch (VER-281 class): eligible_properties is
  // public-SELECT, so without filtering by the active admin client a staff user
  // could open the book-on-behalf page for ANY tenant's property (+ strata PII).
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  // ── 1. Property + collection area ──────────────────────────────────────
  const { data: property } = await supabase
    .from('eligible_properties')
    .select(
      `id, formatted_address, address, is_mud, unit_count, mud_code,
       mud_onboarding_status, waste_location_notes, collection_area_id,
       strata_contact:strata_contact_id(id, first_name, last_name, full_name, mobile_e164, email),
       collection_area:collection_area_id!inner(id, code, name, capacity_pool_id, client_id)`
    )
    .eq('id', id)
    .eq('collection_area.client_id', clientId)
    .single()

  if (!property) redirect('/admin/properties')
  if (!property.is_mud) redirect(`/admin/properties/${id}`)
  if (property.mud_onboarding_status !== 'Registered') {
    redirect(`/admin/properties/${id}`)
  }

  const area = Array.isArray(property.collection_area)
    ? property.collection_area[0]
    : property.collection_area
  const strata = Array.isArray(property.strata_contact)
    ? property.strata_contact[0]
    : property.strata_contact

  if (!area || !strata) redirect(`/admin/properties/${id}`)

  // Per-client T&Cs — staff acknowledge on the resident's behalf (mud_admin).
  const { data: clientRow } = await supabase
    .from('client')
    .select('terms_markdown')
    .eq('id', area.client_id)
    .maybeSingle()
  const termsMarkdown = clientRow?.terms_markdown ?? null

  // ── 2. Current FY ───────────────────────────────────────────────────────
  const { data: fy } = await supabase
    .from('financial_year')
    .select('id, label')
    .eq('is_current', true)
    .single()
  if (!fy) redirect(`/admin/properties/${id}`)

  // ── 3. Services available in this collection area ──────────────────────
  const { data: rules } = await supabase
    .from('service_rules')
    .select(
      `service_id, max_collections,
       service:service_id(id, name, is_active, category:category_id(code))`
    )
    .eq('collection_area_id', area.id)

  const serviceOptions: ServiceOption[] = (rules ?? [])
    .map((r) => {
      const svc = Array.isArray(r.service) ? r.service[0] : r.service
      const cat = svc?.category
      const catRow = Array.isArray(cat) ? cat[0] : cat
      if (!svc || !svc.is_active) return null
      return {
        service_id: r.service_id,
        name: svc.name,
        category_code: catRow?.code ?? 'bulk',
        max_collections_per_unit: r.max_collections,
      }
    })
    .filter((s): s is ServiceOption => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  // ── 4. Per-service current usage ───────────────────────────────────────
  const serviceIds = serviceOptions.map((s) => s.service_id)
  const { data: usageRows } = serviceIds.length
    ? await supabase
        .from('booking_item')
        .select(
          'no_services, service_id, booking!inner(property_id, fy_id, status)'
        )
        .eq('booking.property_id', id)
        .eq('booking.fy_id', fy.id)
        .not('booking.status', 'in', '("Cancelled","Pending Payment")')
        .in('service_id', serviceIds)
    : { data: [] }

  const usageByService = new Map<string, number>()
  for (const row of usageRows ?? []) {
    usageByService.set(row.service_id, (usageByService.get(row.service_id) ?? 0) + row.no_services)
  }

  // ── 5. Allocation overrides for these services this FY ────────────────
  const { data: overrides } = serviceIds.length
    ? await supabase
        .from('allocation_override')
        .select('service_id, extra_allocations')
        .eq('property_id', id)
        .eq('fy_id', fy.id)
        .in('service_id', serviceIds)
    : { data: [] }

  const overrideByService = new Map<string, number>()
  for (const row of overrides ?? []) {
    overrideByService.set(
      row.service_id,
      (overrideByService.get(row.service_id) ?? 0) + row.extra_allocations
    )
  }

  // Pre-compute the per-service allowance summary so the form can render
  // remaining figures next to each checkbox
  const allowanceSummary = checkMudAllowance({
    unit_count: property.unit_count,
    services: serviceOptions.map((s) => ({
      service_id: s.service_id,
      service_name: s.name,
      max_collections_per_unit: s.max_collections_per_unit,
      used: usageByService.get(s.service_id) ?? 0,
      override_extras: overrideByService.get(s.service_id) ?? 0,
      requested: 0,
    })),
  })

  // ── 6. Available collection dates: for_mud=true, is_open, ≤12mo ahead ──
  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)
  const horizonIso = new Date(today.getTime() + TWELVE_MONTHS_MS).toISOString().slice(0, 10)

  const poolId = (area as { capacity_pool_id: string | null }).capacity_pool_id ?? null

  const [{ data: dates }, { data: poolDates }] = await Promise.all([
    supabase
      .from('collection_date')
      .select(
        `id, date, for_mud, is_open,
         bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
         anc_capacity_limit, anc_units_booked, anc_is_closed,
         id_capacity_limit, id_units_booked, id_is_closed`
      )
      .eq('collection_area_id', area.id)
      .eq('for_mud', true)
      .eq('is_open', true)
      .gte('date', todayIso)
      .lte('date', horizonIso)
      .order('date', { ascending: true }),
    poolId
      ? supabase
          .from('collection_date_pool')
          .select(
            `date,
             bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
             anc_capacity_limit, anc_units_booked, anc_is_closed,
             id_capacity_limit, id_units_booked, id_is_closed`
          )
          .eq('capacity_pool_id', poolId)
          .gte('date', todayIso)
          .lte('date', horizonIso)
      : Promise.resolve({ data: [] }),
  ])

  const poolByDate = indexPoolDates(poolDates ?? [])

  const dateOptions: DateOption[] = (dates ?? []).map((d) => {
    const cap = effectiveCapacity(d, poolId, poolByDate)
    return {
      id: d.id,
      date: d.date,
      bulk_remaining: cap.bulk_capacity_limit - cap.bulk_units_booked,
      bulk_closed: cap.bulk_is_closed,
      anc_remaining: cap.anc_capacity_limit - cap.anc_units_booked,
      anc_closed: cap.anc_is_closed,
      id_remaining: cap.id_capacity_limit - cap.id_units_booked,
      id_closed: cap.id_is_closed,
    }
  })

  return (
    <MudBookingForm
      property={{
        id: property.id,
        formatted_address: property.formatted_address ?? property.address,
        mud_code: property.mud_code,
        unit_count: property.unit_count,
        waste_location_notes: property.waste_location_notes,
        area_code: area.code,
        area_name: area.name,
      }}
      strataContact={strata}
      services={serviceOptions}
      allowanceSummary={allowanceSummary.per_service}
      dates={dateOptions}
      mudUnitsPerService={MUD_UNITS_PER_SERVICE}
      termsMarkdown={termsMarkdown}
    />
  )
}
