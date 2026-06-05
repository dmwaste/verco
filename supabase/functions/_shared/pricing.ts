// Calculation logic mirrored in src/lib/pricing/calculate.ts — keep in sync
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'

export interface PricingItem {
  service_id: string
  quantity: number
}

export interface PricedLineItem {
  service_id: string
  quantity: number
  free_units: number
  paid_units: number
  unit_price_cents: number
  line_charge_cents: number
  is_extra: boolean
  category_code: string
}

export interface PriceCalculationResult {
  line_items: PricedLineItem[]
  total_cents: number
  override_applied: boolean
  override_reason?: string
}

/**
 * An applied allocation swap (e.g. 3 Ancillary -> 1 Green). Mirrors
 * src/lib/pricing/calculate.ts ActiveConversion. Residential only — never
 * scaled by unitMultiplier (guarded in calculatePrice).
 */
export interface ActiveConversion {
  from_category_code: string
  to_category_code: string
  to_service_id: string
  from_units: number
  to_units: number
}

/**
 * Server-side pricing engine implementing the dual-limit free unit calculation.
 *
 * A unit becomes paid (extra) when EITHER limit is exhausted:
 *   category_remaining = allocation_rules.max_collections - FY usage across ALL services in that category
 *   service_remaining  = service_rules.max_collections - FY usage for THIS specific service
 *   free_units         = MIN(requested_qty, category_remaining, service_remaining)
 *
 * Only free_units consume category budget — paid units do not reduce the remaining count.
 */
export async function calculatePrice(
  supabase: SupabaseClient,
  propertyId: string,
  collectionAreaId: string,
  fyId: string,
  items: PricingItem[],
  /**
   * Booking ID to exclude from FY-usage counting. Used by the admin
   * "Edit services" flow: the wizard creates a new booking that REPLACES
   * an existing one, so the existing booking's items should not count
   * against the resident's FY allowance during the re-pricing (otherwise
   * the new selection looks like "additional" services and gets charged
   * as extras). Pass the old booking's UUID via the `replaces` param.
   */
  excludeBookingId?: string,
  /**
   * For MUD properties: multiply all service and category maxes by unit count.
   * Defaults to 1 (no scaling) for standard residential properties.
   */
  unitMultiplier = 1,
  /**
   * An applied allocation swap. Residential only — ignored when unitMultiplier
   * != 1 (MUD swaps are out of scope; their from/to units must not be scaled).
   */
  conversion?: ActiveConversion,
): Promise<PriceCalculationResult> {
  const serviceIds = items.map((i) => i.service_id)

  // FY-usage query — filter out the replaced booking when in edit mode
  let usageQuery = supabase
    .from('booking_item')
    .select('service_id, no_services, booking!inner(property_id, fy_id, status)')
    .eq('booking.property_id', propertyId)
    .eq('booking.fy_id', fyId)
    .not('booking.status', 'in', '("Cancelled","Pending Payment")')
  if (excludeBookingId) {
    usageQuery = usageQuery.neq('booking_id', excludeBookingId)
  }

  // Parallel fetches for rules, allocation, services, FY usage, and overrides
  const [rulesResult, allocResult, servicesResult, usageResult, overrideResult] = await Promise.all([
    // Service rules for this collection area
    supabase
      .from('service_rules')
      .select('service_id, max_collections, extra_unit_price')
      .eq('collection_area_id', collectionAreaId)
      .in('service_id', serviceIds),

    // Allocation rules at category level
    supabase
      .from('allocation_rules')
      .select('max_collections, category!inner(code)')
      .eq('collection_area_id', collectionAreaId),

    // Services with their category codes
    supabase
      .from('service')
      .select('id, category!inner(code)')
      .in('id', serviceIds),

    usageQuery,

    // Allocation overrides for this property and FY
    supabase
      .from('allocation_override')
      .select('service_id, extra_allocations, reason')
      .eq('property_id', propertyId)
      .eq('fy_id', fyId),
  ])

  const rulesMap = new Map(
    (rulesResult.data ?? []).map((r) => [r.service_id, r])
  )

  const categoryMaxMap = new Map<string, number>()
  if (allocResult.data) {
    for (const rule of allocResult.data) {
      const cat = rule.category as unknown as { code: string }
      categoryMaxMap.set(cat.code, rule.max_collections)
    }
  }

  const serviceCategoryMap = new Map<string, string>()
  if (servicesResult.data) {
    for (const svc of servicesResult.data) {
      const cat = svc.category as unknown as { code: string }
      serviceCategoryMap.set(svc.id, cat.code)
    }
  }

  // Build override maps: service_id → SUM(extra_allocations), category_code → SUM(extra_allocations)
  const serviceExtraMap = new Map<string, number>()
  const categoryExtraMap = new Map<string, number>()
  let firstOverrideReason: string | undefined
  if (overrideResult.data) {
    for (const override of overrideResult.data) {
      serviceExtraMap.set(
        override.service_id,
        (serviceExtraMap.get(override.service_id) ?? 0) + override.extra_allocations,
      )
      const catCode = serviceCategoryMap.get(override.service_id)
      if (catCode) {
        categoryExtraMap.set(
          catCode,
          (categoryExtraMap.get(catCode) ?? 0) + override.extra_allocations,
        )
      }
      if (!firstOverrideReason) {
        firstOverrideReason = override.reason
      }
    }
  }

  // Per-service usage
  const serviceUsageMap = new Map<string, number>()
  // Per-category usage (total)
  const categoryUsageMap = new Map<string, number>()

  if (usageResult.data) {
    for (const item of usageResult.data) {
      serviceUsageMap.set(
        item.service_id,
        (serviceUsageMap.get(item.service_id) ?? 0) + item.no_services
      )
      const catCode = serviceCategoryMap.get(item.service_id)
      if (catCode) {
        categoryUsageMap.set(
          catCode,
          (categoryUsageMap.get(catCode) ?? 0) + item.no_services
        )
      }
    }
  }

  // Calculate per item with dual-limit check and override awareness
  const categoryFormUsed = new Map<string, number>()

  // Apply an active allocation swap as a budget delta on LOCAL copies (never
  // mutate the source maps). Residential only: skipped for MUDs (unitMultiplier
  // != 1) so swap units are never scaled by unit count. Mirrors calculate.ts.
  const effectiveCategoryMax = new Map(categoryMaxMap)
  const serviceMaxBonus = new Map<string, number>()
  if (conversion && unitMultiplier === 1) {
    effectiveCategoryMax.set(
      conversion.from_category_code,
      Math.max(0, (effectiveCategoryMax.get(conversion.from_category_code) ?? 0) - conversion.from_units),
    )
    effectiveCategoryMax.set(
      conversion.to_category_code,
      (effectiveCategoryMax.get(conversion.to_category_code) ?? 0) + conversion.to_units,
    )
    serviceMaxBonus.set(conversion.to_service_id, conversion.to_units)
  }

  const lineItems: PricedLineItem[] = items.map((item) => {
    const rule = rulesMap.get(item.service_id)
    const catCode = serviceCategoryMap.get(item.service_id) ?? ''

    // Service-level remaining (with additive extra allocations; scaled by unit count for MUDs)
    const serviceUsed = serviceUsageMap.get(item.service_id) ?? 0
    const serviceMax = (rule?.max_collections ?? 0) * unitMultiplier + (serviceMaxBonus.get(item.service_id) ?? 0)
    const serviceRemaining = Math.max(0, (serviceMax + (serviceExtraMap.get(item.service_id) ?? 0)) - serviceUsed)

    // Category-level remaining (with additive extra allocations; scaled by unit count for MUDs)
    const catMax = (effectiveCategoryMax.get(catCode) ?? 0) * unitMultiplier
    const catFyUsed = categoryUsageMap.get(catCode) ?? 0
    const catAlreadyConsumedByForm = categoryFormUsed.get(catCode) ?? 0
    const categoryRemaining = Math.max(0, (catMax + (categoryExtraMap.get(catCode) ?? 0)) - catFyUsed - catAlreadyConsumedByForm)

    // Dual-limit: free_units = MIN(quantity, category_remaining, service_remaining)
    const freeUnits = Math.min(item.quantity, categoryRemaining, serviceRemaining)
    const paidUnits = item.quantity - freeUnits

    // Only free_units consume category budget
    categoryFormUsed.set(catCode, catAlreadyConsumedByForm + freeUnits)

    const unitPriceCents = Math.round((rule?.extra_unit_price ?? 0) * 100)
    const lineChargeCents = paidUnits * unitPriceCents

    return {
      service_id: item.service_id,
      quantity: item.quantity,
      free_units: freeUnits,
      paid_units: paidUnits,
      unit_price_cents: unitPriceCents,
      line_charge_cents: lineChargeCents,
      is_extra: paidUnits > 0,
      category_code: catCode,
    }
  })

  const totalCents = lineItems.reduce((sum, l) => sum + l.line_charge_cents, 0)

  const overrideApplied = serviceExtraMap.size > 0

  return {
    line_items: lineItems,
    total_cents: totalCents,
    override_applied: overrideApplied,
    override_reason: overrideApplied ? firstOverrideReason : undefined,
  }
}
