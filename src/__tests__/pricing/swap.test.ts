import { describe, it, expect } from 'vitest'
import {
  isSwapEligible,
  toActiveConversion,
  findExistingSwapRuleId,
  type ConversionRuleRow, swapUnavailableReason } from '@/lib/pricing/swap'

describe('isSwapEligible', () => {
  it('eligible when a rule exists, 0 ancillary used, no existing swap, no ancillary in cart', () => {
    expect(
      isSwapEligible({ hasRule: true, ancillaryFyUsed: 0, hasExistingSwap: false, ancillaryInCart: 0 }),
    ).toBe(true)
  })

  it('ineligible if any ancillary used this FY', () => {
    expect(
      isSwapEligible({ hasRule: true, ancillaryFyUsed: 1, hasExistingSwap: false, ancillaryInCart: 0 }),
    ).toBe(false)
  })

  it('ineligible if no rule, existing swap, or ancillary in cart', () => {
    expect(isSwapEligible({ hasRule: false, ancillaryFyUsed: 0, hasExistingSwap: false, ancillaryInCart: 0 })).toBe(false)
    expect(isSwapEligible({ hasRule: true, ancillaryFyUsed: 0, hasExistingSwap: true, ancillaryInCart: 0 })).toBe(false)
    expect(isSwapEligible({ hasRule: true, ancillaryFyUsed: 0, hasExistingSwap: false, ancillaryInCart: 2 })).toBe(false)
  })
})

describe('findExistingSwapRuleId', () => {
  it('returns the conversion-rule id from a swap usage row', () => {
    expect(
      findExistingSwapRuleId([
        { usage_kind: 'service', usage_key: 'svc-green' },
        { usage_kind: 'category', usage_key: 'bulk' },
        { usage_kind: 'swap', usage_key: 'rule-1' },
      ]),
    ).toBe('rule-1')
  })

  it('returns null when no swap row is present (usage-only rows)', () => {
    expect(
      findExistingSwapRuleId([
        { usage_kind: 'service', usage_key: 'svc-green' },
        { usage_kind: 'category', usage_key: 'bulk' },
      ]),
    ).toBeNull()
  })

  it('returns null for empty, null, or undefined row sets', () => {
    expect(findExistingSwapRuleId([])).toBeNull()
    expect(findExistingSwapRuleId(null)).toBeNull()
    expect(findExistingSwapRuleId(undefined)).toBeNull()
  })
})

describe('toActiveConversion', () => {
  it('maps a conversion-rule row to the engine ActiveConversion shape', () => {
    const row: ConversionRuleRow = {
      id: 'rule-1',
      from_units: 3,
      to_units: 1,
      to_service_id: 'svc-green',
      from_category_code: 'anc',
      to_category_code: 'bulk',
    }
    expect(toActiveConversion(row)).toEqual({
      from_category_code: 'anc',
      to_category_code: 'bulk',
      to_service_id: 'svc-green',
      from_units: 3,
      to_units: 1,
    })
  })
})

describe('swapUnavailableReason (#449 — explain why the checkbox is hidden)', () => {
  const base = { hasRule: true, ancillaryFyUsed: 0, hasExistingSwap: false, ancillaryInCart: 0 }

  it('null when eligible, when no rule exists, or when a swap is already applied (those have their own UI)', () => {
    expect(swapUnavailableReason(base)).toBeNull()
    expect(swapUnavailableReason({ ...base, hasRule: false, ancillaryFyUsed: 2 })).toBeNull()
    expect(swapUnavailableReason({ ...base, hasExistingSwap: true, ancillaryFyUsed: 3 })).toBeNull()
  })

  it('"used" once any ancillary has been used this FY — the all-or-nothing rule', () => {
    expect(swapUnavailableReason({ ...base, ancillaryFyUsed: 1 })).toBe('used')
  })

  it('"in-cart" when the only blocker is ancillary items in the current booking', () => {
    expect(swapUnavailableReason({ ...base, ancillaryInCart: 1 })).toBe('in-cart')
  })

  it('"used" wins over "in-cart" (removing cart items would not help)', () => {
    expect(swapUnavailableReason({ ...base, ancillaryFyUsed: 1, ancillaryInCart: 1 })).toBe('used')
  })
})
