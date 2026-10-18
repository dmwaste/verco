import { describe, it, expect } from 'vitest'
import { maskPhone, repairStoredPhone } from '../lib/phone-repair'

describe('maskPhone — script output shows the shape, never the number', () => {
  it('keeps the first 4 characters and masks every later digit', () => {
    expect(maskPhone('+61412345678')).toBe('+614dddddddd')
    expect(maskPhone('412345678')).toBe('4123ddddd')
  })

  it('masks digits inside free text and collapses line breaks', () => {
    expect(maskPhone('0412 345 678\n\n0498 765 432')).toBe('0412 ddd ddd dddd ddd ddd')
  })
})

/**
 * Repair rules for contacts.mobile_e164 values already on file (18/10/2026
 * audit). Every case here is a shape found on prod; digits are made up. A rule
 * only fires when the repaired value is provably the same number; everything
 * else is left for staff, who can check with the resident.
 */

describe('repairStoredPhone — fixes', () => {
  it.each([
    ['412345678', '+61412345678', 'au-mobile'], // typed without the 0
    ['+44412345678', '+61412345678', 'au-mobile'], // browser autofill, UK region
    ['+10412345678', '+61412345678', 'au-mobile'], // browser autofill, US region
    ['+610412345678', '+61412345678', 'au-mobile'], // redundant 0 after +61
    ['862564449', '0862564449', 'landline-trunk-0'], // landline typed without the 0
    ['+610862564449', '+61862564449', 'landline-redundant-0'],
    ['93851234', '0893851234', 'wa-local'], // Perth local without its area code
    ['63801234', '0863801234', 'wa-local'],
    ['+6193851234', '0893851234', 'wa-local'], // +61 prefixed onto a Perth local
    ['+61093851234', '0893851234', 'wa-local'],
  ])('%s → %s (%s)', (raw, to, rule) => {
    expect(repairStoredPhone(raw)).toEqual({ action: 'fix', to, rule })
  })

  it.each([[''], ['notconfirmed']])('clears %j, which holds no number', (raw) => {
    expect(repairStoredPhone(raw)).toEqual({ action: 'fix', to: null, rule: 'no-number' })
  })
})

describe('repairStoredPhone — leaves valid numbers alone', () => {
  it.each([
    ['+61412345678', 'canonical mobile'],
    ['+61862564449', 'E.164 landline'],
    ['0862564449', 'local landline'],
    ['1300975707', '1300'],
    ['131234', '13xx'],
    ['+447700900123', 'UK mobile'],
    ['+31612345678', 'Dutch mobile'],
    ['+41441234567', 'Swiss number'],
  ])('%s (%s)', (raw) => {
    expect(repairStoredPhone(raw)).toEqual({ action: 'keep' })
  })
})

describe('repairStoredPhone — needs a person', () => {
  it.each([
    ['+6141234567', 'AU mobile a digit short'],
    ['+614123456789', 'AU mobile a digit long'],
    ['041234567', 'local mobile a digit short'],
    ['04123456789', 'local mobile a digit long'],
    ['4123456789', 'mobile without 0, a digit long'],
    ['+6131234567', '+61 then 8 digits that are not a Perth local'],
    ['+6186256444912', '+61 landline too long'],
    ['0123456789', 'no such AU prefix'],
    ['0412 345 678\n\n0498 765 432', 'two numbers in one cell'],
    ['9362 1234, Alternative email: someone@example.com', 'number plus free text'],
  ])('%j (%s)', (raw) => {
    expect(repairStoredPhone(raw).action).toBe('manual')
  })
})
