import { describe, it, expect } from 'vitest'
import { buildConfirmBreakdown, type BreakdownInput } from '@/lib/pricing/build-breakdown'
import type { ServiceRule } from '@/lib/pricing/calculate'

/**
 * Confirm-page breakdown helper.
 *
 * The headline test is the regression for the confirm-page bug: a paid unit
 * whose paid-ness comes from the *category* cap (not the per-service limit)
 * must appear in `extras`. The old service-only logic dropped it.
 */

const SVC_GENERAL = 'svc-general'
const SVC_GREEN = 'svc-green'
const SVC_MATTRESS = 'svc-mattress'
const CAT_BULK = 'bulk'
const CAT_ANC = 'anc'

// Kwinana-shaped config: Bulk cat=2 (General/Green svc=2 each, $89.67),
// Ancillary cat=3 (Mattress svc=1, $45).
function kwinanaInput(
  items: Array<{ service_id: string; quantity: number }>,
  usageOverrides: Partial<{
    service: [string, number][]
    category: [string, number][]
  }> = {},
): BreakdownInput {
  const rulesMap = new Map<string, ServiceRule>([
    [SVC_GENERAL, { max_collections: 2, extra_unit_price: 89.67 }],
    [SVC_GREEN, { max_collections: 2, extra_unit_price: 89.67 }],
    [SVC_MATTRESS, { max_collections: 1, extra_unit_price: 45 }],
  ])
  return {
    items,
    serviceNames: new Map([
      [SVC_GENERAL, 'General'],
      [SVC_GREEN, 'Green'],
      [SVC_MATTRESS, 'Mattress'],
    ]),
    serviceCategoryMap: new Map([
      [SVC_GENERAL, CAT_BULK],
      [SVC_GREEN, CAT_BULK],
      [SVC_MATTRESS, CAT_ANC],
    ]),
    rulesMap,
    categoryMaxMap: new Map([
      [CAT_BULK, 2],
      [CAT_ANC, 3],
    ]),
    serviceUsageMap: new Map(usageOverrides.service ?? []),
    categoryUsageMap: new Map(usageOverrides.category ?? []),
  }
}

describe('buildConfirmBreakdown', () => {
  it('REGRESSION: a category-cap-driven paid unit appears in extras', () => {
    // 2 General + 1 Green = 3 Bulk items. No single service over its 2-limit,
    // but the Bulk category cap of 2 is exhausted by the 2 General → the Green
    // is paid. The old service-only confirm logic showed all three "Included".
    const result = buildConfirmBreakdown(
      kwinanaInput([
        { service_id: SVC_GENERAL, quantity: 2 },
        { service_id: SVC_GREEN, quantity: 1 },
      ]),
    )

    expect(result.included).toEqual([{ name: 'General', qty: 2 }])
    expect(result.extras).toEqual([
      { name: 'Green', qty: 1, unitPrice: 89.67, lineTotal: 89.67 },
    ])
  })

  it('all-free booking has no extras', () => {
    const result = buildConfirmBreakdown(
      kwinanaInput([{ service_id: SVC_GENERAL, quantity: 1 }]),
    )
    expect(result.included).toEqual([{ name: 'General', qty: 1 }])
    expect(result.extras).toEqual([])
  })

  it('service-cap-driven paid unit still appears (parity with old behaviour)', () => {
    // 1 Mattress over the Mattress service limit of 1 → 1 paid, even though
    // the Ancillary category (3) is not exhausted.
    const result = buildConfirmBreakdown(
      kwinanaInput([{ service_id: SVC_MATTRESS, quantity: 2 }]),
    )
    expect(result.included).toEqual([{ name: 'Mattress', qty: 1 }])
    expect(result.extras).toEqual([
      { name: 'Mattress', qty: 1, unitPrice: 45, lineTotal: 45 },
    ])
  })

  it('respects prior FY usage at the category level', () => {
    // 1 Green this cart, but the property already used 2 Bulk this FY →
    // category exhausted → the Green is paid.
    const result = buildConfirmBreakdown(
      kwinanaInput([{ service_id: SVC_GREEN, quantity: 1 }], {
        category: [[CAT_BULK, 2]],
        service: [[SVC_GENERAL, 2]],
      }),
    )
    expect(result.included).toEqual([])
    expect(result.extras).toEqual([
      { name: 'Green', qty: 1, unitPrice: 89.67, lineTotal: 89.67 },
    ])
  })

  it('reflects an active swap: the extra Green is included, no extras', () => {
    // With the swap, 2 General + 1 Green are all free (2 base Bulk + 1 swapped Green).
    const result = buildConfirmBreakdown({
      ...kwinanaInput([
        { service_id: SVC_GENERAL, quantity: 2 },
        { service_id: SVC_GREEN, quantity: 1 },
      ]),
      conversion: {
        from_category_code: CAT_ANC,
        to_category_code: CAT_BULK,
        to_service_id: SVC_GREEN,
        from_units: 3,
        to_units: 1,
      },
    })
    expect(result.extras).toEqual([])
    expect(result.included).toEqual([
      { name: 'General', qty: 2 },
      { name: 'Green', qty: 1 },
    ])
  })
})
