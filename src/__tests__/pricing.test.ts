import { describe, it, expect } from 'vitest'
import {
  computeLineItems,
  type ServiceRule,
  type AllocationOverride,
} from '@/lib/pricing/calculate'

// Helpers to build maps concisely
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

// Reusable IDs
const SVC_GENERAL = 'svc-general'
const SVC_GREEN = 'svc-green'
const SVC_MATTRESS = 'svc-mattress'
const SVC_EWASTE = 'svc-ewaste'
const CAT_BULK = 'bulk'
const CAT_ANC = 'anc'

describe('computeLineItems', () => {
  // ── Basic free/paid ────────────────────────────────────

  describe('basic free/paid allocation', () => {
    it('all free — quantity within both category and service limits', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 2 }],
        rules([[SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 5]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items).toHaveLength(1)
      expect(result.line_items[0]!.free_units).toBe(2)
      expect(result.line_items[0]!.paid_units).toBe(0)
      expect(result.line_items[0]!.is_extra).toBe(false)
      expect(result.total_cents).toBe(0)
    })

    it('all paid — both limits exhausted', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 3 }],
        rules([[SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 5]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        usage([[SVC_GENERAL, 5]]),  // service fully used
        usage([[CAT_BULK, 5]]),     // category fully used
      )
      expect(result.line_items[0]!.free_units).toBe(0)
      expect(result.line_items[0]!.paid_units).toBe(3)
      expect(result.line_items[0]!.is_extra).toBe(true)
      expect(result.total_cents).toBe(3 * 5000)
    })

    it('partial free — service limit is binding', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 3 }],
        rules([[SVC_GENERAL, { max_collections: 2, extra_unit_price: 40 }]]),
        catMax([[CAT_BULK, 10]]),   // category has plenty
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.free_units).toBe(2)
      expect(result.line_items[0]!.paid_units).toBe(1)
      expect(result.line_items[0]!.line_charge_cents).toBe(4000)
    })

    it('partial free — category limit is binding', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 3 }],
        rules([[SVC_GENERAL, { max_collections: 10, extra_unit_price: 40 }]]),
        catMax([[CAT_BULK, 2]]),    // category is the constraint
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.free_units).toBe(2)
      expect(result.line_items[0]!.paid_units).toBe(1)
      expect(result.line_items[0]!.line_charge_cents).toBe(4000)
    })
  })

  // ── Dual-limit MIN logic ───────────────────────────────

  describe('dual-limit MIN(qty, category_remaining, service_remaining)', () => {
    it('quantity is smallest', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 1 }],
        rules([[SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 5]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.free_units).toBe(1)
      expect(result.line_items[0]!.paid_units).toBe(0)
    })

    it('category_remaining is smallest', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 5 }],
        rules([[SVC_GENERAL, { max_collections: 10, extra_unit_price: 30 }]]),
        catMax([[CAT_BULK, 2]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.free_units).toBe(2)
      expect(result.line_items[0]!.paid_units).toBe(3)
    })

    it('service_remaining is smallest', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 5 }],
        rules([[SVC_GENERAL, { max_collections: 3, extra_unit_price: 30 }]]),
        catMax([[CAT_BULK, 10]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.free_units).toBe(3)
      expect(result.line_items[0]!.paid_units).toBe(2)
    })

    it('exact boundary — all three equal', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 3 }],
        rules([[SVC_GENERAL, { max_collections: 3, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 3]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.free_units).toBe(3)
      expect(result.line_items[0]!.paid_units).toBe(0)
      expect(result.total_cents).toBe(0)
    })
  })

  // ── Cross-item category budget (categoryFormUsed) ──────

  describe('cross-item category budget consumption', () => {
    it('two items same category — first consumes budget, second gets fewer free', () => {
      const result = computeLineItems(
        [
          { service_id: SVC_GENERAL, quantity: 3 },
          { service_id: SVC_GREEN, quantity: 3 },
        ],
        rules([
          [SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }],
          [SVC_GREEN, { max_collections: 5, extra_unit_price: 40 }],
        ]),
        catMax([[CAT_BULK, 4]]),   // only 4 free across the category
        svcCat([
          [SVC_GENERAL, CAT_BULK],
          [SVC_GREEN, CAT_BULK],
        ]),
        empty(),
        empty(),
      )
      // General takes 3 free (of 4 category budget)
      expect(result.line_items[0]!.free_units).toBe(3)
      expect(result.line_items[0]!.paid_units).toBe(0)
      // Green gets only 1 free (4 - 3 = 1 remaining)
      expect(result.line_items[1]!.free_units).toBe(1)
      expect(result.line_items[1]!.paid_units).toBe(2)
      expect(result.line_items[1]!.line_charge_cents).toBe(2 * 4000)
    })

    it('three items progressive depletion of category budget', () => {
      const result = computeLineItems(
        [
          { service_id: SVC_GENERAL, quantity: 2 },
          { service_id: SVC_GREEN, quantity: 2 },
          { service_id: SVC_MATTRESS, quantity: 2 },
        ],
        rules([
          [SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }],
          [SVC_GREEN, { max_collections: 5, extra_unit_price: 40 }],
          [SVC_MATTRESS, { max_collections: 5, extra_unit_price: 60 }],
        ]),
        catMax([[CAT_BULK, 5]]),
        svcCat([
          [SVC_GENERAL, CAT_BULK],
          [SVC_GREEN, CAT_BULK],
          [SVC_MATTRESS, CAT_BULK],
        ]),
        empty(),
        empty(),
      )
      // General: 2 free (5 - 0 = 5 remaining, min(2, 5, 5) = 2)
      expect(result.line_items[0]!.free_units).toBe(2)
      expect(result.line_items[0]!.paid_units).toBe(0)
      // Green: 2 free (5 - 2 = 3 remaining, min(2, 3, 5) = 2)
      expect(result.line_items[1]!.free_units).toBe(2)
      expect(result.line_items[1]!.paid_units).toBe(0)
      // Mattress: 1 free (5 - 4 = 1 remaining, min(2, 1, 5) = 1)
      expect(result.line_items[2]!.free_units).toBe(1)
      expect(result.line_items[2]!.paid_units).toBe(1)
    })

    it('two different categories — independent budgets', () => {
      const result = computeLineItems(
        [
          { service_id: SVC_GENERAL, quantity: 3 },
          { service_id: SVC_MATTRESS, quantity: 3 },
        ],
        rules([
          [SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }],
          [SVC_MATTRESS, { max_collections: 5, extra_unit_price: 60 }],
        ]),
        catMax([
          [CAT_BULK, 3],
          [CAT_ANC, 3],
        ]),
        svcCat([
          [SVC_GENERAL, CAT_BULK],
          [SVC_MATTRESS, CAT_ANC],
        ]),
        empty(),
        empty(),
      )
      // Each gets full 3 free from their own category
      expect(result.line_items[0]!.free_units).toBe(3)
      expect(result.line_items[0]!.paid_units).toBe(0)
      expect(result.line_items[1]!.free_units).toBe(3)
      expect(result.line_items[1]!.paid_units).toBe(0)
      expect(result.total_cents).toBe(0)
    })

    it('mixed categories — one depleted, one independent', () => {
      const result = computeLineItems(
        [
          { service_id: SVC_GENERAL, quantity: 2 },
          { service_id: SVC_GREEN, quantity: 2 },
          { service_id: SVC_MATTRESS, quantity: 2 },
        ],
        rules([
          [SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }],
          [SVC_GREEN, { max_collections: 5, extra_unit_price: 40 }],
          [SVC_MATTRESS, { max_collections: 5, extra_unit_price: 60 }],
        ]),
        catMax([
          [CAT_BULK, 3],  // General + Green share this
          [CAT_ANC, 5],   // Mattress has its own
        ]),
        svcCat([
          [SVC_GENERAL, CAT_BULK],
          [SVC_GREEN, CAT_BULK],
          [SVC_MATTRESS, CAT_ANC],
        ]),
        empty(),
        empty(),
      )
      // General: 2 free (min(2, 3, 5) = 2)
      expect(result.line_items[0]!.free_units).toBe(2)
      // Green: 1 free (3 - 2 = 1 cat remaining, min(2, 1, 5) = 1)
      expect(result.line_items[1]!.free_units).toBe(1)
      expect(result.line_items[1]!.paid_units).toBe(1)
      // Mattress: 2 free (independent category, min(2, 5, 5) = 2)
      expect(result.line_items[2]!.free_units).toBe(2)
      expect(result.line_items[2]!.paid_units).toBe(0)
    })
  })

  // ── Price math ─────────────────────────────────────────

  describe('price calculations', () => {
    it('unit_price_cents = round(extra_unit_price * 100)', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 2 }],
        rules([[SVC_GENERAL, { max_collections: 0, extra_unit_price: 49.99 }]]),
        catMax([[CAT_BULK, 0]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.unit_price_cents).toBe(4999)
    })

    it('rounds fractional cents correctly', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 1 }],
        rules([[SVC_GENERAL, { max_collections: 0, extra_unit_price: 49.995 }]]),
        catMax([[CAT_BULK, 0]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      // 49.995 * 100 = 4999.5 → rounds to 5000
      expect(result.line_items[0]!.unit_price_cents).toBe(5000)
    })

    it('line_charge_cents = paid_units * unit_price_cents', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 5 }],
        rules([[SVC_GENERAL, { max_collections: 2, extra_unit_price: 30 }]]),
        catMax([[CAT_BULK, 10]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      // 3 paid * 3000 cents = 9000
      expect(result.line_items[0]!.paid_units).toBe(3)
      expect(result.line_items[0]!.line_charge_cents).toBe(9000)
    })

    it('total_cents sums all line charges', () => {
      const result = computeLineItems(
        [
          { service_id: SVC_GENERAL, quantity: 3 },
          { service_id: SVC_MATTRESS, quantity: 2 },
        ],
        rules([
          [SVC_GENERAL, { max_collections: 1, extra_unit_price: 50 }],
          [SVC_MATTRESS, { max_collections: 0, extra_unit_price: 60 }],
        ]),
        catMax([
          [CAT_BULK, 10],
          [CAT_ANC, 10],
        ]),
        svcCat([
          [SVC_GENERAL, CAT_BULK],
          [SVC_MATTRESS, CAT_ANC],
        ]),
        empty(),
        empty(),
      )
      // General: 2 paid * 5000 = 10000
      // Mattress: 2 paid * 6000 = 12000
      expect(result.total_cents).toBe(22000)
    })

    it('all-free booking produces total_cents = 0', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 1 }],
        rules([[SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 5]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.total_cents).toBe(0)
    })
  })

  // ── is_extra flag ──────────────────────────────────────

  describe('is_extra flag', () => {
    it('false when paid_units = 0', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 1 }],
        rules([[SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 5]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.is_extra).toBe(false)
    })

    it('true when paid_units > 0', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 3 }],
        rules([[SVC_GENERAL, { max_collections: 1, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 10]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.is_extra).toBe(true)
    })
  })

  // ── Edge cases ─────────────────────────────────────────

  describe('edge cases', () => {
    it('empty items array', () => {
      const result = computeLineItems([], empty(), empty(), empty(), empty(), empty())
      expect(result.line_items).toHaveLength(0)
      expect(result.total_cents).toBe(0)
    })

    it('zero quantity item', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 0 }],
        rules([[SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 5]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.free_units).toBe(0)
      expect(result.line_items[0]!.paid_units).toBe(0)
      expect(result.line_items[0]!.line_charge_cents).toBe(0)
    })

    it('unknown service (no rule) defaults to 0 max and 0 price', () => {
      const result = computeLineItems(
        [{ service_id: 'unknown-svc', quantity: 2 }],
        empty(),  // no rules
        empty(),
        empty(),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.free_units).toBe(0)
      expect(result.line_items[0]!.paid_units).toBe(2)
      expect(result.line_items[0]!.unit_price_cents).toBe(0)
      expect(result.line_items[0]!.line_charge_cents).toBe(0)
    })

    it('zero max_collections means everything is paid', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 3 }],
        rules([[SVC_GENERAL, { max_collections: 0, extra_unit_price: 25 }]]),
        catMax([[CAT_BULK, 0]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.free_units).toBe(0)
      expect(result.line_items[0]!.paid_units).toBe(3)
      expect(result.line_items[0]!.line_charge_cents).toBe(3 * 2500)
    })

    it('prior FY usage reduces remaining allocations', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 3 }],
        rules([[SVC_GENERAL, { max_collections: 5, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 5]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        usage([[SVC_GENERAL, 3]]),  // 3 already used for this service
        usage([[CAT_BULK, 3]]),     // 3 already used for this category
      )
      // remaining: min(3, 5-3, 5-3) = min(3, 2, 2) = 2
      expect(result.line_items[0]!.free_units).toBe(2)
      expect(result.line_items[0]!.paid_units).toBe(1)
    })

    it('category_code defaults to empty string for unmapped service', () => {
      const result = computeLineItems(
        [{ service_id: 'unmapped', quantity: 1 }],
        rules([['unmapped', { max_collections: 0, extra_unit_price: 10 }]]),
        empty(),
        empty(), // no service-to-category mapping
        empty(),
        empty(),
      )
      expect(result.line_items[0]!.category_code).toBe('')
    })
  })

  // ── Allocation overrides (additive extra_allocations) ──

  describe('allocation overrides (additive)', () => {
    it('extra adds to both service and category limits', () => {
      const overrides: AllocationOverride[] = [
        { service_id: SVC_GENERAL, extra_allocations: 2, reason: 'Admin granted extra' },
      ]

      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 4 }],
        rules([[SVC_GENERAL, { max_collections: 3, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 3]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        usage([[SVC_GENERAL, 3]]),  // service fully used
        usage([[CAT_BULK, 3]]),     // category fully used
        overrides,
      )

      // effective_service_max = 3 + 2 = 5, used = 3 → remaining = 2
      // effective_category_max = 3 + 2 = 5, used = 3 → remaining = 2
      // free = MIN(4, 2, 2) = 2, paid = 2
      expect(result.line_items[0]!.free_units).toBe(2)
      expect(result.line_items[0]!.paid_units).toBe(2)
      expect(result.override_applied).toBe(true)
      expect(result.override_reason).toBe('Admin granted extra')
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

      expect(result.line_items[0]!.free_units).toBe(3)
      expect(result.line_items[0]!.paid_units).toBe(0)
      expect(result.override_applied).toBe(false)
      expect(result.override_reason).toBeUndefined()
      expect(result.total_cents).toBe(0)
    })

    it('override on one service rolls up to category but not other services', () => {
      const overrides: AllocationOverride[] = [
        { service_id: SVC_GENERAL, extra_allocations: 3, reason: 'Bulk extra' },
      ]

      const result = computeLineItems(
        [
          { service_id: SVC_GENERAL, quantity: 3 },
          { service_id: SVC_GREEN, quantity: 3 },
        ],
        rules([
          [SVC_GENERAL, { max_collections: 2, extra_unit_price: 50 }],
          [SVC_GREEN, { max_collections: 2, extra_unit_price: 40 }],
        ]),
        catMax([[CAT_BULK, 2]]),
        svcCat([
          [SVC_GENERAL, CAT_BULK],
          [SVC_GREEN, CAT_BULK],
        ]),
        empty(),
        empty(),
        overrides,
      )

      // General: effective_service = 2+3 = 5, remaining = 5. Cat = 2+3 = 5, remaining = 5.
      // free = MIN(3, 5, 5) = 3
      expect(result.line_items[0]!.free_units).toBe(3)
      expect(result.line_items[0]!.paid_units).toBe(0)
      // Green: effective_service = 2+0 = 2, remaining = 2. Cat = 5 - 3(form) = 2.
      // free = MIN(3, 2, 2) = 2, paid = 1
      expect(result.line_items[1]!.free_units).toBe(2)
      expect(result.line_items[1]!.paid_units).toBe(1)
    })

    it('multiple overrides for same service sum their extras', () => {
      const overrides: AllocationOverride[] = [
        { service_id: SVC_GENERAL, extra_allocations: 1, reason: 'First' },
        { service_id: SVC_GENERAL, extra_allocations: 2, reason: 'Second' },
      ]

      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 5 }],
        rules([[SVC_GENERAL, { max_collections: 2, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 2]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
        overrides,
      )

      // effective_service = 2 + 1 + 2 = 5, effective_category = 2 + 1 + 2 = 5
      // free = MIN(5, 5, 5) = 5
      expect(result.line_items[0]!.free_units).toBe(5)
      expect(result.line_items[0]!.paid_units).toBe(0)
      expect(result.override_reason).toBe('First')
    })
  })

  // ── MUD unit multiplier ────────────────────────────────

  describe('MUD unit multiplier', () => {
    it('unitMultiplier=1 (default) behaves identically to no multiplier', () => {
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 2 }],
        rules([[SVC_GENERAL, { max_collections: 1, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 1]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
        undefined,
        1,
      )
      expect(result.line_items[0]!.free_units).toBe(1)
      expect(result.line_items[0]!.paid_units).toBe(1)
    })

    it('scales category and service limits by unit count — all free when within scaled limits', () => {
      // Council rule: 1 per category, 1 per service. MUD with 10 units → effective 10 of each.
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 8 }],
        rules([[SVC_GENERAL, { max_collections: 1, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 1]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
        undefined,
        10,
      )
      expect(result.line_items[0]!.free_units).toBe(8)
      expect(result.line_items[0]!.paid_units).toBe(0)
      expect(result.total_cents).toBe(0)
    })

    it('charges for units beyond the scaled limit', () => {
      // Council rule: 1, MUD 4 units → effective 4. Requesting 6 → 2 paid.
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 6 }],
        rules([[SVC_GENERAL, { max_collections: 1, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 1]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
        undefined,
        4,
      )
      expect(result.line_items[0]!.free_units).toBe(4)
      expect(result.line_items[0]!.paid_units).toBe(2)
      expect(result.total_cents).toBe(2 * 50 * 100)
    })

    it('dual-limit still applies — binding limit wins', () => {
      // Category rule 1 → scaled 5. Service rule 2 → scaled 10. Requesting 7.
      // Category is binding: free = MIN(7, 5, 10) = 5.
      const result = computeLineItems(
        [{ service_id: SVC_GENERAL, quantity: 7 }],
        rules([[SVC_GENERAL, { max_collections: 2, extra_unit_price: 50 }]]),
        catMax([[CAT_BULK, 1]]),
        svcCat([[SVC_GENERAL, CAT_BULK]]),
        empty(),
        empty(),
        undefined,
        5,
      )
      expect(result.line_items[0]!.free_units).toBe(5)
      expect(result.line_items[0]!.paid_units).toBe(2)
    })
  })
})
