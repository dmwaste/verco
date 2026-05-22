/**
 * Node-compatible pricing engine — extracted from supabase/functions/_shared/pricing.ts.
 * Keep in sync with the Edge Function version.
 *
 * This module contains the pure calculation logic (no Supabase dependency)
 * so it can be unit tested with Vitest and reused in client-side previews.
 */

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

export interface AllocationOverride {
  service_id: string
  extra_allocations: number
  reason: string
}

export interface ServiceRule {
  max_collections: number
  extra_unit_price: number
}

/**
 * Pure pricing calculation implementing the dual-limit free unit model.
 *
 * A unit becomes paid (extra) when EITHER limit is exhausted:
 *   effective_service_max  = service_rules.max_collections + SUM(overrides.extra_allocations for this service)
 *   effective_category_max = allocation_rules.max_collections + SUM(overrides.extra_allocations for all services in category)
 *   service_remaining  = effective_service_max - serviceUsageMap[svc]
 *   category_remaining = effective_category_max - categoryUsageMap[cat] - categoryFormUsed[cat]
 *   free_units         = MIN(requested_qty, category_remaining, service_remaining)
 *
 * Only free_units consume category budget — paid units do not reduce the remaining count.
 *
 * Overrides are purely additive — no date boundary logic needed.
 */
export function computeLineItems(
  items: PricingItem[],
  rulesMap: Map<string, ServiceRule>,
  categoryMaxMap: Map<string, number>,
  serviceCategoryMap: Map<string, string>,
  serviceUsageMap: Map<string, number>,
  categoryUsageMap: Map<string, number>,
  overrides?: AllocationOverride[],
  /**
   * For MUD properties: multiply all service and category maxes by unit count.
   * Defaults to 1 (no scaling) for standard residential properties.
   */
  unitMultiplier = 1,
): PriceCalculationResult {
  // Build override maps: service_id → SUM(extra_allocations), category_code → SUM(extra_allocations)
  const serviceExtraMap = new Map<string, number>()
  const categoryExtraMap = new Map<string, number>()
  let firstOverrideReason: string | undefined
  if (overrides) {
    for (const override of overrides) {
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

  const categoryFormUsed = new Map<string, number>()

  const line_items: PricedLineItem[] = items.map((item) => {
    const rule = rulesMap.get(item.service_id)
    const catCode = serviceCategoryMap.get(item.service_id) ?? ''

    // Service-level remaining (with additive extra allocations; scaled by unit count for MUDs)
    const serviceUsed = serviceUsageMap.get(item.service_id) ?? 0
    const serviceMax = (rule?.max_collections ?? 0) * unitMultiplier
    const serviceRemaining = Math.max(0, (serviceMax + (serviceExtraMap.get(item.service_id) ?? 0)) - serviceUsed)

    // Category-level remaining (with additive extra allocations; scaled by unit count for MUDs)
    const catMax = (categoryMaxMap.get(catCode) ?? 0) * unitMultiplier
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

  const total_cents = line_items.reduce((sum, l) => sum + l.line_charge_cents, 0)

  const overrideApplied = serviceExtraMap.size > 0

  return {
    line_items,
    total_cents,
    override_applied: overrideApplied,
    override_reason: overrideApplied ? firstOverrideReason : undefined,
  }
}
