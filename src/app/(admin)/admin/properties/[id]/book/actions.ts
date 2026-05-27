'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { checkMudAllowance } from '@/lib/mud/allowance'
import { MUD_UNITS_PER_SERVICE } from '@/lib/mud/capacity'
import { invokeSendNotification } from '@/lib/notifications/invoke'

type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E }

const STAFF_ROLES = ['contractor-admin', 'contractor-staff', 'client-admin', 'client-staff']

async function validateStaffRole(): Promise<Result<string>> {
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  if (!role || !STAFF_ROLES.includes(role)) {
    return { ok: false, error: 'Insufficient permissions. Admin role required.' }
  }
  return { ok: true, data: role }
}

export interface CreateMudBookingInput {
  property_id: string
  collection_date_id: string
  service_ids: string[]
  notes?: string | null
}

export async function createMudBooking(
  input: CreateMudBookingInput
): Promise<Result<{ booking_id: string; ref: string }>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  if (input.service_ids.length === 0) {
    return { ok: false, error: 'At least one service must be selected.' }
  }

  const supabase = await createClient()

  // ── 1. Load the MUD property + strata contact + collection area ─────────
  const { data: property, error: propError } = await supabase
    .from('eligible_properties')
    .select(
      `id, is_mud, unit_count, mud_onboarding_status, strata_contact_id,
       waste_location_notes, collection_area_id,
       collection_area:collection_area_id(id, code, client_id, contractor_id)`
    )
    .eq('id', input.property_id)
    .single()

  if (propError || !property) {
    return { ok: false, error: propError?.message ?? 'Property not found' }
  }

  if (!property.is_mud) {
    return { ok: false, error: 'Property is not a MUD.' }
  }
  if (property.mud_onboarding_status !== 'Registered') {
    return { ok: false, error: 'MUD must be in Registered status to create bookings.' }
  }
  if (!property.strata_contact_id) {
    return { ok: false, error: 'MUD has no strata contact.' }
  }
  if (!property.collection_area_id) {
    return { ok: false, error: 'MUD has no collection area.' }
  }

  const area = Array.isArray(property.collection_area)
    ? property.collection_area[0]
    : property.collection_area
  if (!area) {
    return { ok: false, error: 'Collection area not found.' }
  }

  // ── 2. Resolve current FY ───────────────────────────────────────────────
  const { data: fy, error: fyError } = await supabase
    .from('financial_year')
    .select('id')
    .eq('is_current', true)
    .single()

  if (fyError || !fy) {
    return { ok: false, error: 'No active financial year found.' }
  }

  // ── 3. Verify collection date is for_mud + open ─────────────────────────
  const { data: collDate, error: collDateError } = await supabase
    .from('collection_date')
    .select('id, date, for_mud, is_open, collection_area_id')
    .eq('id', input.collection_date_id)
    .single()

  if (collDateError || !collDate) {
    return { ok: false, error: 'Collection date not found.' }
  }
  if (!collDate.for_mud) {
    return { ok: false, error: 'Selected date is not enabled for MUD bookings.' }
  }
  if (!collDate.is_open) {
    return { ok: false, error: 'Selected collection date is closed.' }
  }
  if (collDate.collection_area_id !== property.collection_area_id) {
    return { ok: false, error: 'Collection date is for a different area.' }
  }

  // ── 4. Load service rules for the requested services + their categories ─
  const { data: rules, error: rulesError } = await supabase
    .from('service_rules')
    .select(
      `service_id, max_collections,
       service:service_id(id, name, category:category_id(code))`
    )
    .eq('collection_area_id', property.collection_area_id)
    .in('service_id', input.service_ids)

  if (rulesError) return { ok: false, error: rulesError.message }
  if (!rules || rules.length !== input.service_ids.length) {
    return { ok: false, error: 'One or more services are not valid for this area.' }
  }

  // ── 5. MUD allowance check: per-service FY usage vs cap ─────────────────
  // Usage = sum of no_services across all booking_items for this property,
  // this service, in non-Cancelled bookings for the current FY.
  const { data: usageRows, error: usageError } = await supabase
    .from('booking_item')
    .select(
      'no_services, service_id, booking!inner(property_id, fy_id, status)'
    )
    .eq('booking.property_id', input.property_id)
    .eq('booking.fy_id', fy.id)
    .not('booking.status', 'in', '("Cancelled","Pending Payment")')
    .in('service_id', input.service_ids)

  if (usageError) return { ok: false, error: usageError.message }

  const usageByService = new Map<string, number>()
  for (const row of usageRows ?? []) {
    usageByService.set(row.service_id, (usageByService.get(row.service_id) ?? 0) + row.no_services)
  }

  // Allocation overrides for these services this FY
  const { data: overrides, error: overrideError } = await supabase
    .from('allocation_override')
    .select('service_id, extra_allocations')
    .eq('property_id', input.property_id)
    .eq('fy_id', fy.id)
    .in('service_id', input.service_ids)

  if (overrideError) return { ok: false, error: overrideError.message }

  const overrideByService = new Map<string, number>()
  for (const row of overrides ?? []) {
    overrideByService.set(
      row.service_id,
      (overrideByService.get(row.service_id) ?? 0) + row.extra_allocations
    )
  }

  const allowanceInput = rules.map((r) => {
    const svc = Array.isArray(r.service) ? r.service[0] : r.service
    return {
      service_id: r.service_id,
      service_name: svc?.name ?? 'Unknown service',
      max_collections_per_unit: r.max_collections,
      used: usageByService.get(r.service_id) ?? 0,
      override_extras: overrideByService.get(r.service_id) ?? 0,
      requested: MUD_UNITS_PER_SERVICE,
    }
  })

  const allowance = checkMudAllowance({
    unit_count: property.unit_count,
    services: allowanceInput,
  })

  if (!allowance.ok) {
    return { ok: false, error: allowance.errors.join(' ') }
  }

  // ── 6. Build RPC items payload ──────────────────────────────────────────
  // Each service gets MUD_UNITS_PER_SERVICE (2) placeholder units, all free,
  // routed into the appropriate category bucket on the collection_date.
  const rpcItems = rules.map((r) => {
    const svc = Array.isArray(r.service) ? r.service[0] : r.service
    const cat = svc?.category
    const catRow = Array.isArray(cat) ? cat[0] : cat
    return {
      service_id: r.service_id,
      no_services: MUD_UNITS_PER_SERVICE,
      unit_price_cents: 0,
      is_extra: false,
      category_code: catRow?.code ?? 'bulk',
    }
  })

  // ── 7. Call the capacity-safe RPC ───────────────────────────────────────
  // p_type='MUD' so the booking is created atomically as a MUD record (no
  // post-write UPDATE race). p_status='Confirmed' so free MUD bookings skip
  // the legacy Submitted step (CLAUDE.md §7 — free path lands directly in
  // Confirmed; migration 20260518005936 documents this for create-booking
  // EF, and the BEFORE-UPDATE state-machine trigger doesn't gate INSERTs).
  // p_actor_id stamps audit_log with the acting staff member.
  const { data: { user: actingUser } } = await supabase.auth.getUser()

  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    'create_booking_with_capacity_check',
    {
      p_collection_date_id: input.collection_date_id,
      p_property_id: input.property_id,
      p_contact_id: property.strata_contact_id,
      p_collection_area_id: property.collection_area_id,
      p_client_id: area.client_id,
      p_contractor_id: area.contractor_id,
      p_fy_id: fy.id,
      p_area_code: area.code,
      p_location: property.waste_location_notes ?? '',
      p_notes: input.notes ?? '',
      p_status: 'Confirmed',
      p_items: rpcItems,
      p_actor_id: actingUser?.id,
      p_type: 'MUD',
    }
  )

  if (rpcError) {
    if (rpcError.message?.includes('Insufficient')) {
      return { ok: false, error: rpcError.message }
    }
    return { ok: false, error: `Failed to create booking: ${rpcError.message}` }
  }

  const result = rpcResult as { booking_id: string; ref: string }

  // Fire booking_created to the strata contact (email + SMS — per-channel
  // idempotency per memory feedback-multi-channel-idempotency.md).
  // Fire-and-forget; failure is logged but does not block the booking.
  void invokeSendNotification(supabase, {
    type: 'booking_created',
    booking_id: result.booking_id,
  })

  revalidatePath(`/admin/properties/${input.property_id}`)
  revalidatePath('/admin/bookings')

  return { ok: true, data: { booking_id: result.booking_id, ref: result.ref } }
}
