import type { createClient } from '@/lib/supabase/server'
import { checkMudAllowance, type MudAllowanceServiceResult } from '@/lib/mud/allowance'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export interface MudContext {
  propertyId: string
  mudCode: string | null
  unitCount: number
  onboardingStatus: string | null
  strataContact: {
    firstName: string
    lastName: string
    fullName: string
    email: string | null
    mobile: string | null
  } | null
  allowance: MudAllowanceServiceResult[]
}

interface BuildMudContextInput {
  propertyId: string
  collectionAreaId: string
  fyId: string
}

/**
 * Fetch the MUD-specific context for an admin booking detail page —
 * property unit_count + mud_code, strata contact, and per-service
 * allowance summary (used / cap / remaining) for the booking's FY.
 *
 * Reuses `checkMudAllowance` from `src/lib/mud/allowance.ts` for the
 * math; this function is purely the data-fetching wrapper.
 *
 * Returns `null` if the property is not flagged is_mud (defensive — the
 * caller already gates on booking.type === 'MUD', but the property could
 * theoretically have flipped since the booking was created).
 */
export async function buildMudContext(
  supabase: SupabaseServerClient,
  input: BuildMudContextInput
): Promise<MudContext | null> {
  const { data: property } = await supabase
    .from('eligible_properties')
    .select(
      `id, is_mud, unit_count, mud_code, mud_onboarding_status,
       strata_contact:strata_contact_id(first_name, last_name, full_name, mobile_e164, email)`
    )
    .eq('id', input.propertyId)
    .single()

  if (!property || !property.is_mud) return null

  const strata = Array.isArray(property.strata_contact)
    ? property.strata_contact[0]
    : property.strata_contact

  // Load the service rules for this area to know the per-unit caps
  const { data: rules } = await supabase
    .from('service_rules')
    .select(
      `service_id, max_collections,
       service:service_id(id, name, is_active)`
    )
    .eq('collection_area_id', input.collectionAreaId)

  const activeServices = (rules ?? [])
    .map((r) => {
      const svc = Array.isArray(r.service) ? r.service[0] : r.service
      if (!svc || !svc.is_active) return null
      return {
        service_id: r.service_id,
        service_name: svc.name,
        max_collections_per_unit: r.max_collections,
      }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)

  const serviceIds = activeServices.map((s) => s.service_id)
  if (serviceIds.length === 0) {
    return {
      propertyId: property.id,
      mudCode: property.mud_code,
      unitCount: property.unit_count,
      onboardingStatus: property.mud_onboarding_status,
      strataContact: strata
        ? {
            firstName: strata.first_name,
            lastName: strata.last_name,
            fullName: strata.full_name,
            email: strata.email,
            mobile: strata.mobile_e164,
          }
        : null,
      allowance: [],
    }
  }

  // Per-service current usage this FY (non-Cancelled, non-Pending Payment)
  const { data: usageRows } = await supabase
    .from('booking_item')
    .select('no_services, service_id, booking!inner(property_id, fy_id, status)')
    .eq('booking.property_id', input.propertyId)
    .eq('booking.fy_id', input.fyId)
    .not('booking.status', 'in', '("Cancelled","Pending Payment")')
    .in('service_id', serviceIds)

  const usageByService = new Map<string, number>()
  for (const row of usageRows ?? []) {
    usageByService.set(
      row.service_id,
      (usageByService.get(row.service_id) ?? 0) + row.no_services
    )
  }

  // Allocation overrides this FY
  const { data: overrides } = await supabase
    .from('allocation_override')
    .select('service_id, extra_allocations')
    .eq('property_id', input.propertyId)
    .eq('fy_id', input.fyId)
    .in('service_id', serviceIds)

  const overrideByService = new Map<string, number>()
  for (const row of overrides ?? []) {
    overrideByService.set(
      row.service_id,
      (overrideByService.get(row.service_id) ?? 0) + row.extra_allocations
    )
  }

  const allowance = checkMudAllowance({
    unit_count: property.unit_count,
    services: activeServices.map((s) => ({
      service_id: s.service_id,
      service_name: s.service_name,
      max_collections_per_unit: s.max_collections_per_unit,
      used: usageByService.get(s.service_id) ?? 0,
      override_extras: overrideByService.get(s.service_id) ?? 0,
      requested: 0,
    })),
  })

  return {
    propertyId: property.id,
    mudCode: property.mud_code,
    unitCount: property.unit_count,
    onboardingStatus: property.mud_onboarding_status,
    strataContact: strata
      ? {
          firstName: strata.first_name,
          lastName: strata.last_name,
          fullName: strata.full_name,
          email: strata.email,
          mobile: strata.mobile_e164,
        }
      : null,
    allowance: allowance.per_service,
  }
}
