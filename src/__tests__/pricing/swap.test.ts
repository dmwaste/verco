import { describe, it, expect } from 'vitest'
import {
  isSwapEligible,
  toActiveConversion,
  findExistingSwapRuleId,
  type ConversionRuleRow,
} from '@/lib/pricing/swap'

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
