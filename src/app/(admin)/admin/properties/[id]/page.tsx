import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveAuditLogs } from '@/lib/audit/resolve'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { canManageAllocations } from '@/lib/auth/roles'
import { PropertyDetailClient } from './property-detail-client'

interface PropertyDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function AdminPropertyDetailPage({
  params,
}: PropertyDetailPageProps) {
  const { id } = await params
  const supabase = await createClient()

  // Step 1: Fetch property + current FY in parallel (needed for subsequent queries)
  // Property select uses `*` plus joined relations — `*` covers MUD columns
  // (is_mud, mud_code, mud_onboarding_status, unit_count, collection_cadence,
  // waste_location_notes, auth_form_url) which the MUD section consumes.
  // Resolve the active admin client first — the property fetch is tenant-scoped
  // by it (VER-281).
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  const [{ data: property }, { data: fy }] = await Promise.all([
    supabase
      .from('eligible_properties')
      .select(
        '*, collection_area!inner(id, name, code, client_id), strata_contact:strata_contact_id(id, first_name, last_name, full_name, mobile_e164, email)'
      )
      .eq('id', id)
      // Tenant-scope the fetch (VER-281): eligible_properties is public-SELECT
      // (RLS USING(true)), so without this any staff user could load another
      // tenant's property + strata PII by URL. A cross-tenant id yields no row →
      // the redirect below returns them to the properties list.
      .eq('collection_area.client_id', clientId)
      .single(),
    supabase
      .from('financial_year')
      .select('id, label')
      .eq('is_current', true)
      .single(),
  ])

  if (!property) {
    redirect('/admin/properties')
  }

  if (!fy) {
    redirect('/admin/properties')
  }

  // Step 2: Fetch bookings for this property in current FY
  // booking_item.actual_services is included so the MUD detail section can
  // show actual collected counts for completed MUD bookings.
  const { data: bookings } = await supabase
    .from('booking')
    .select(
      `id, ref, status, type, created_at,
       contact:contact_id(full_name),
       booking_item(no_services, actual_services, service!inner(name), collection_date!inner(date))`
    )
    .eq('property_id', id)
    .eq('fy_id', fy.id)
    .order('created_at', { ascending: false })
    .limit(20)

  // Step 2b: MUD-specific lookups (only when relevant)
  // - nextExpected: next-due reminder date for Registered MUDs (cadence-based view)
  // - authFormSignedUrl: 1h signed URL for the strata authority form (when uploaded)
  let nextExpected: { last_date: string | null; next_expected_date: string | null } | null = null
  if (property.is_mud && property.mud_onboarding_status === 'Registered') {
    // The property fetch above is tenant-scoped (VER-281), so `id` is always the
    // current tenant's here — the MUD view lookup is safe by construction.
    const { data: nx } = await supabase
      .from('v_mud_next_expected')
      .select('last_date, next_expected_date')
      .eq('property_id', id)
      .maybeSingle()
    nextExpected = nx ?? null
  }

  let authFormSignedUrl: string | null = null
  if (property.auth_form_url) {
    const { data: signed } = await supabase.storage
      .from('mud-auth-forms')
      .createSignedUrl(property.auth_form_url, 60 * 60)
    authFormSignedUrl = signed?.signedUrl ?? null
  }

  const bookingIds = (bookings ?? []).map((b) => b.id)

  // Step 3: Fetch NCNs, NPs, service tickets, allocation overrides, allocation rules, FY usage in parallel
  const [
    { data: ncns },
    { data: nps },
    { data: serviceTickets },
    { data: allocationOverrides },
    { data: allocationRules },
    { data: fyUsage },
  ] = await Promise.all([
    // NCNs via booking IDs
    bookingIds.length > 0
      ? supabase
          .from('non_conformance_notice')
          .select(
            'id, status, contractor_fault, reported_at, booking:booking!non_conformance_notice_booking_id_fkey(id, ref)'
          )
          .in('booking_id', bookingIds)
      : Promise.resolve({ data: [] as never[] }),

    // NPs via booking IDs
    bookingIds.length > 0
      ? supabase
          .from('nothing_presented')
          .select(
            'id, status, contractor_fault, reported_at, booking:booking!nothing_presented_booking_id_fkey(id, ref)'
          )
          .in('booking_id', bookingIds)
      : Promise.resolve({ data: [] as never[] }),

    // Service tickets via booking IDs
    bookingIds.length > 0
      ? supabase
          .from('service_ticket')
          .select('id, display_id, subject, status, created_at')
          .in('booking_id', bookingIds)
      : Promise.resolve({ data: [] as never[] }),

    // Allocation overrides for this property
    supabase
      .from('allocation_override')
      .select(
        'id, extra_allocations, reason, created_at, created_by, service!inner(name, category!inner(name))'
      )
      .eq('property_id', id)
      .order('created_at', { ascending: false }),

    // Allocation rules for this property's collection area
    supabase
      .from('allocation_rules')
      .select('max_collections, category!inner(name, code)')
      .eq('collection_area_id', property.collection_area_id!),

    // FY usage — booking_items for this property in current FY
    supabase
      .from('booking_item')
      .select(
        'no_services, service!inner(category!inner(code)), booking!inner(property_id, fy_id, status)'
      )
      .eq('booking.property_id', id)
      .eq('booking.fy_id', fy.id)
      .not('booking.status', 'in', '("Cancelled","Pending Payment")'),
  ])

  // Fetch resolved audit trail (property + strata user links)
  const auditLogs = await resolveAuditLogs(supabase, 'eligible_properties', id, {
    includeChildren: [
      { table: 'strata_user_properties', fkColumn: 'property_id' },
    ],
  })

  // Contractor tier + client-admin may adjust allocations (gates the button;
  // RLS enforces the write). client-staff / read-only roles see values only.
  const { data: role } = await supabase.rpc('current_user_role')
  const canManage = canManageAllocations(role)

  return (
    <PropertyDetailClient
      property={property}
      fy={fy}
      bookings={bookings ?? []}
      ncns={ncns ?? []}
      nps={nps ?? []}
      serviceTickets={serviceTickets ?? []}
      allocationOverrides={allocationOverrides ?? []}
      allocationRules={allocationRules ?? []}
      fyUsage={fyUsage ?? []}
      nextExpected={nextExpected}
      authFormSignedUrl={authFormSignedUrl}
      auditLogs={auditLogs}
      canManageAllocations={canManage}
    />
  )
}
