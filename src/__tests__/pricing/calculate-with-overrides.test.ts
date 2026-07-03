import { describe, it, expect } from 'vitest'
import { computeLineItems, type ServiceRule, type AllocationOverride } from '@/lib/pricing/calculate'

/**
 * Test suite for pricing calculation with the additive extra_allocations override model.
 *
 * Scenarios:
 * 1. Extra Mattress +2 → Mattress service limit +2, Ancillary category limit +2
 * 2. Extra General +1 → General service limit +1, Bulk category limit +1
 * 3. Multiple overrides for same service sum (two +1 Mattress = +2 total)
 * 4. No override = standard calculation (regression)
 * 5. Dual-limit: adding extra to one service doesn't affect other services beyond category rollup
 * 6. Category exhausted by other service — extra on one service limited by category ceiling
 */

// Reusable IDs
const SVC_GENERAL = 'svc-general'
const SVC_GREEN = 'svc-green'
const SVC_MATTRESS = 'svc-mattress'
const SVC_EWASTE = 'svc-ewaste'
const CAT_BULK = 'bulk'
const CAT_ANC = 'anc'

// Helpers
function rules(entries: [string, ServiceRule][]): Map<string, ServiceRule> {
  return new Map(entries)
}
function catMax(entries: [string, number][]): Map<string, number> {
  return new Map(entries)
}
function svcCat(entries: [string, string][]): Map<string, string> {
  return new Map(entries)
}
function usage(entries: [string, number][]): Map<string, number> {
  return new Map(entries)
}
const empty = () => new Map()

describe('computeLineItems with additive extra_allocations overrides', () => {
  it('extra Mattress +2 increases Mattress service limit and Ancillary category limit', () => {
    // Base: Mattress max=1, Ancillary category max=2, all used
    const overrides: AllocationOverride[] = [
      { service_id: SVC_MATTRESS, extra_allocations: 2, reason: 'Compassionate extra' },
    ]

    const result = computeLineItems(
      [{ service_id: SVC_MATTRESS, quantity: 3 }],
      rules([[SVC_MATTRESS, { max_collections: 1, extra_unit_price: 60 }]]),
      catMax([[CAT_ANC, 2]]),
      svcCat([[SVC_MATTRESS, CAT_ANC]]),
      usage([[SVC_MATTRESS, 1]]),   // service fully used (1 of 1)
      usage([[CAT_ANC, 2]]),        // category fully used (2 of 2)
      overrides,
    )

    // effective_service_max = 1 + 2 = 3, used = 1 → service_remaining = 2
    // effective_category_max = 2 + 2 = 4, used = 2 → category_remaining = 2
    // free = MIN(3, 2, 2) = 2, paid = 1
    expect(result.line_items[0]!.free_units).toBe(2)
    expect(result.line_items[0]!.paid_units).toBe(1)
    expect(result.line_items[0]!.line_charge_cents).toBe(6000)
    expect(result.override_applied).toBe(true)
    expect(result.override_reason).toBe('Compassionate extra')
  })

  it('extra General +1 increases General service limit and Bulk category limit', () => {
    const overrides: AllocationOverride[] = [
      { service_id: SVC_GENERAL, extra_allocations: 1, reason: 'Admin granted extra' },
    ]

    const result = computeLineItems(
      [{ service_id: SVC_GENERAL, quantity: 3 }],
      rules([[SVC_GENERAL, { max_collections: 2, extra_unit_price: 50 }]]),
      catMax([[CAT_BULK, 3]]),
      svcCat([[SVC_GENERAL, CAT_BULK]]),
      usage([[SVC_GENERAL, 2]]),    // service fully used
      usage([[CAT_BULK, 3]]),       // category fully used
      overrides,
    )

    // effective_service_max = 2 + 1 = 3, used = 2 → service_remaining = 1
    // effective_category_max = 3 + 1 = 4, used = 3 → category_remaining = 1
    // free = MIN(3, 1, 1) = 1, paid = 2
    expect(result.line_items[0]!.free_units).toBe(1)
    expect(result.line_items[0]!.paid_units).toBe(2)
    expect(result.line_items[0]!.line_charge_cents).toBe(10000)
    expect(result.override_applied).toBe(true)
    expect(result.override_reason).toBe('Admin granted extra')
  })

  it('multiple overrides for same service sum their extra_allocations', () => {
    const overrides: AllocationOverride[] = [
      { service_id: SVC_MATTRESS, extra_allocations: 1, reason: 'First extra' },
      { service_id: SVC_MATTRESS, extra_allocations: 1, reason: 'Second extra' },
    ]

    const result = computeLineItems(
      [{ service_id: SVC_MATTRESS, quantity: 4 }],
      rules([[SVC_MATTRESS, { max_collections: 1, extra_unit_price: 60 }]]),
      catMax([[CAT_ANC, 2]]),
      svcCat([[SVC_MATTRESS, CAT_ANC]]),
      usage([[SVC_MATTRESS, 1]]),   // 1 of 1 used
      usage([[CAT_ANC, 2]]),        // 2 of 2 used
      overrides,
    )

    // effective_service_max = 1 + 1 + 1 = 3, used = 1 → service_remaining = 2
    // effective_category_max = 2 + 1 + 1 = 4, used = 2 → category_remaining = 2
    // free = MIN(4, 2, 2) = 2, paid = 2
    expect(result.line_items[0]!.free_units).toBe(2)
    expect(result.line_items[0]!.paid_units).toBe(2)
    expect(result.line_items[0]!.line_charge_cents).toBe(12000)
    // First override reason is used
    expect(result.override_reason).toBe('First extra')
  })

  it('no override = standard calculation (regression)', () => {
    const result = computeLineItems(
      [{ service_id: SVC_GENERAL, quantity: 3 }],
      rules([[SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }]]),
      catMax([[CAT_BULK, 5]]),
      svcCat([[SVC_GENERAL, CAT_BULK]]),
      usage([[SVC_GENERAL, 2]]),
      usage([[CAT_BULK, 2]]),
      undefined,
    )

    // Standard: min(3, 5-2, 5-2) = 3 free
    expect(result.line_items[0]!.free_units).toBe(3)
    expect(result.line_items[0]!.paid_units).toBe(0)
    expect(result.override_applied).toBe(false)
    expect(result.override_reason).toBeUndefined()
    expect(result.total_cents).toBe(0)
  })

  it('extra on one service does not increase other services service-level limits in same category', () => {
    // Extra on Mattress (+2) should increase ANC category limit,
    // but E-Waste service limit stays at its base max_collections
    const overrides: AllocationOverride[] = [
      { service_id: SVC_MATTRESS, extra_allocations: 2, reason: 'Mattress extra' },
    ]

    const result = computeLineItems(
      [
        { service_id: SVC_MATTRESS, quantity: 2 },
        { service_id: SVC_EWASTE, quantity: 3 },
      ],
      rules([
        [SVC_MATTRESS, { max_collections: 1, extra_unit_price: 60 }],
        [SVC_EWASTE, { max_collections: 2, extra_unit_price: 40 }],
      ]),
      catMax([[CAT_ANC, 3]]),
      svcCat([
        [SVC_MATTRESS, CAT_ANC],
        [SVC_EWASTE, CAT_ANC],
      ]),
      empty(),
      empty(),
      overrides,
    )

    // Mattress: effective_service_max = 1+2 = 3, remaining = 3. Cat = 3+2 = 5, remaining = 5.
    // free = MIN(2, 5, 3) = 2, paid = 0
    expect(result.line_items[0]!.free_units).toBe(2)
    expect(result.line_items[0]!.paid_units).toBe(0)

    // E-Waste: effective_service_max = 2+0 = 2, remaining = 2. Cat = 5 - 2(form used) = 3.
    // free = MIN(3, 3, 2) = 2, paid = 1  (service limit is binding)
    expect(result.line_items[1]!.free_units).toBe(2)
    expect(result.line_items[1]!.paid_units).toBe(1)
    expect(result.line_items[1]!.line_charge_cents).toBe(4000)
  })

  it('category exhausted by other service — extra on one service limited by category ceiling', () => {
    // General uses all of Bulk category. Green gets extra +2 but category is exhausted.
    const overrides: AllocationOverride[] = [
      { service_id: SVC_GREEN, extra_allocations: 2, reason: 'Green extra' },
    ]

    const result = computeLineItems(
      [{ service_id: SVC_GREEN, quantity: 3 }],
      rules([[SVC_GREEN, { max_collections: 1, extra_unit_price: 40 }]]),
      catMax([[CAT_BULK, 5]]),
      svcCat([
        [SVC_GENERAL, CAT_BULK],
        [SVC_GREEN, CAT_BULK],
      ]),
      usage([[SVC_GREEN, 1]]),       // Green service fully used (1 of 1)
      usage([[CAT_BULK, 5]]),        // Category fully used (5 of 5) by General + Green
      overrides,
    )

    // effective_service_max = 1 + 2 = 3, used = 1 → service_remaining = 2
    // effective_category_max = 5 + 2 = 7, used = 5 → category_remaining = 2
    // free = MIN(3, 2, 2) = 2, paid = 1
    expect(result.line_items[0]!.free_units).toBe(2)
    expect(result.line_items[0]!.paid_units).toBe(1)
    expect(result.line_items[0]!.line_charge_cents).toBe(4000)
    expect(result.override_applied).toBe(true)
  })

  // ── VER-304: negative overrides reduce effective allocation ──────────────
  it('negative override reduces effective service and category allocation below base', () => {
    // Base: General max=3, Bulk category max=3, nothing used. Override -2.
    const overrides: AllocationOverride[] = [
      { service_id: SVC_GENERAL, extra_allocations: -2, reason: 'Correction — prior over-grant' },
    ]

    const result = computeLineItems(
      [{ service_id: SVC_GENERAL, quantity: 3 }],
      rules([[SVC_GENERAL, { max_collections: 3, extra_unit_price: 50 }]]),
      catMax([[CAT_BULK, 3]]),
      svcCat([[SVC_GENERAL, CAT_BULK]]),
      usage([[SVC_GENERAL, 0]]),
      usage([[CAT_BULK, 0]]),
      overrides,
    )

    // effective_service_max = 3 + (-2) = 1 → service_remaining = 1
    // effective_category_max = 3 + (-2) = 1 → category_remaining = 1
    // free = MIN(3, 1, 1) = 1, paid = 2
    expect(result.line_items[0]!.free_units).toBe(1)
    expect(result.line_items[0]!.paid_units).toBe(2)
    expect(result.line_items[0]!.line_charge_cents).toBe(10000)
    expect(result.override_applied).toBe(true)
    expect(result.override_reason).toBe('Correction — prior over-grant')
  })

  it('negative override more than the base floors free units at 0 — never overcharges beyond requested', () => {
    // Override (-5) makes effective allocation negative; the Math.max(0, …) floors
    // must keep free_units at 0 (not negative) so paid_units never exceeds quantity.
    const overrides: AllocationOverride[] = [
      { service_id: SVC_GENERAL, extra_allocations: -5, reason: 'Full removal' },
    ]

    const result = computeLineItems(
      [{ service_id: SVC_GENERAL, quantity: 2 }],
      rules([[SVC_GENERAL, { max_collections: 3, extra_unit_price: 50 }]]),
      catMax([[CAT_BULK, 3]]),
      svcCat([[SVC_GENERAL, CAT_BULK]]),
      usage([[SVC_GENERAL, 0]]),
      usage([[CAT_BULK, 0]]),
      overrides,
    )

    // effective_service_max = 3 + (-5) = -2 → remaining floored to 0
    // effective_category_max = 3 + (-5) = -2 → remaining floored to 0
    // free = MIN(2, 0, 0) = 0 (never negative), paid = 2 (== requested; no overcharge)
    expect(result.line_items[0]!.free_units).toBe(0)
    expect(result.line_items[0]!.paid_units).toBe(2)
    expect(result.line_items[0]!.line_charge_cents).toBe(10000)
  })
})
