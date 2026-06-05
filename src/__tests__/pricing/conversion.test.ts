import { describe, it, expect } from 'vitest'
import {
  computeLineItems,
  type ServiceRule,
  type ActiveConversion,
} from '@/lib/pricing/calculate'

/**
 * Allocation swap (Kwinana): 3 Ancillary -> 1 free Green, modelled as a budget
 * delta on the dual-limit engine. Ancillary category max -3, Bulk category max
 * +1, Green service max +1. General's service cap stays 2, so Green-only
 * enforces itself through the existing MIN().
 */

const GENERAL = 'svc-general'
const GREEN = 'svc-green'
const MATTRESS = 'svc-mattress'
const BULK = 'bulk'
const ANC = 'anc'

const rules = (): Map<string, ServiceRule> =>
  new Map([
    [GENERAL, { max_collections: 2, extra_unit_price: 89.67 }],
    [GREEN, { max_collections: 2, extra_unit_price: 89.67 }],
    [MATTRESS, { max_collections: 1, extra_unit_price: 45 }],
  ])
const catMax = (): Map<string, number> => new Map([[BULK, 2], [ANC, 3]])
const svcCat = (): Map<string, string> =>
  new Map([[GENERAL, BULK], [GREEN, BULK], [MATTRESS, ANC]])
const conversion: ActiveConversion = {
  from_category_code: ANC,
  to_category_code: BULK,
  to_service_id: GREEN,
  from_units: 3,
  to_units: 1,
}

describe('computeLineItems with an active conversion (swap)', () => {
  it('makes a 3rd Bulk collection (Green) free', () => {
    // 2 General + 1 Green = 3 Bulk. Swap raises Bulk cat to 3 and Green svc to 3.
    const r = computeLineItems(
      [
        { service_id: GENERAL, quantity: 2 },
        { service_id: GREEN, quantity: 1 },
      ],
      rules(), catMax(), svcCat(), new Map(), new Map(), undefined, 1, conversion,
    )
    expect(r.total_cents).toBe(0)
    expect(r.line_items.every((l) => l.paid_units === 0)).toBe(true)
  })

  it('does NOT let the extra Bulk slot go to General (Green-only)', () => {
    // 3 General with swap: General svc cap stays 2 -> 1 paid even though Bulk cat is 3.
    const r = computeLineItems(
      [{ service_id: GENERAL, quantity: 3 }],
      rules(), catMax(), svcCat(), new Map(), new Map(), undefined, 1, conversion,
    )
    expect(r.line_items[0]!.free_units).toBe(2)
    expect(r.line_items[0]!.paid_units).toBe(1)
  })

  it('zeroes the Ancillary budget when swapped', () => {
    // 1 Mattress with swap: Ancillary cat 3 -> 0 -> paid.
    const r = computeLineItems(
      [{ service_id: MATTRESS, quantity: 1 }],
      rules(), catMax(), svcCat(), new Map(), new Map(), undefined, 1, conversion,
    )
    expect(r.line_items[0]!.paid_units).toBe(1)
  })

  it('no conversion = unchanged (regression)', () => {
    const r = computeLineItems(
      [{ service_id: GREEN, quantity: 1 }],
      rules(), catMax(), svcCat(), new Map(), new Map(),
    )
    expect(r.line_items[0]!.free_units).toBe(1)
  })

  it('ignores the conversion for MUDs (unitMultiplier > 1) — A2 guard', () => {
    // A 50-unit MUD must not have its swap units scaled. With a multiplier and a
    // conversion both present, the conversion is skipped: Ancillary stays open.
    const r = computeLineItems(
      [{ service_id: MATTRESS, quantity: 1 }],
      rules(), catMax(), svcCat(), new Map(), new Map(), undefined, 50, conversion,
    )
    // Ancillary cat = 3 * 50 = 150, untouched by the (ignored) swap -> free.
    expect(r.line_items[0]!.free_units).toBe(1)
    expect(r.line_items[0]!.paid_units).toBe(0)
  })
})
