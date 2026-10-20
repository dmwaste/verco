import { describe, it, expect } from 'vitest'
import {
  isValidPhone,
  isSmsCapable,
  normalisePhone,
  canonicaliseAuMobile,
} from '@/lib/mud/validation'
import { normaliseAuMobile } from '@/lib/booking/schemas'

describe('isValidPhone — accepts every real AU phone format, rejects junk (VER-315)', () => {
  it.each([
    ['0412345678', 'mobile'],
    ['08 91234567', 'landline, spaced'],
    ['(08) 9123 4567', 'landline, bracketed'],
    ['1300 975 707', '1300 service line'],
    ['1800123456', '1800 service line'],
    ['+61891234567', 'international'],
  ])('accepts %s (%s)', (input) => {
    expect(isValidPhone(input)).toBe(true)
  })

  it.each([
    ['abc', 'letters'],
    ['12345', 'too short (5 digits)'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['+0412345678', 'impossible +0 country code'],
    ['1234567890123456', 'too long (16 digits)'],
    ['0412–345–678', 'en-dash separators (not a phone format we strip)'],
    ['٠٤١٢٣٤٥٦٧٨', 'non-ASCII digits'],
  ])('rejects %s (%s)', (input) => {
    expect(isValidPhone(input)).toBe(false)
  })

  it('accepts exactly 15 digits (upper boundary)', () => {
    expect(isValidPhone('123456789012345')).toBe(true)
  })
})

// #668: a number that looks Australian but has the wrong digit count used to
// pass the loose 6–15-digit rule, was stored raw, and the resident got no SMS.
describe('isValidPhone — an Australian-looking number must have the right length (#668)', () => {
  it.each([
    ['0413 12345', 'mobile a digit short'],
    ['0404 1234567', 'mobile a digit long'],
    ['+61 412 3456', '+61 mobile two digits short'],
    ['+61 0412 345 6789', '+61 0… mobile a digit long'],
    ['+61 08 9123 456', '+61 0… landline a digit short'],
    ['61 412 345 6789', '61 mobile without +, a digit long'],
    ['0061 412 345 67', '0061 mobile a digit short'],
    ['4123 456 789', 'mobile with no 0, a digit long'],
    ['4123 4567', 'mobile with no 0, a digit short'],
    ['9385 1234', '8-digit local number, area code left off'],
    ['08 9123 456', 'landline a digit short'],
    ['(08) 9123 45678', 'landline a digit long'],
    ['1300 975 70', '1300 a digit short'],
    ['1800 123 4567', '1800 a digit long'],
    ['13 12 345', '13 number a digit long'],
  ])('rejects %s (%s)', (input) => {
    expect(isValidPhone(input)).toBe(false)
  })

  it.each([
    ['0412 345 678', 'mobile'],
    ['412 345 678', 'mobile with no 0 (#667 canonicalises it)'],
    ['+61 412 345 678', '+61 mobile'],
    ['+61 0412 345 678', '+61 mobile with the national 0 kept'],
    ['61412345678', '61 mobile without +'],
    ['0061 412 345 678', '0061 mobile'],
    ['+44 412 345 678', 'UK-region autofill of an AU mobile'],
    ['+1 0412 345 678', 'US-region autofill of an AU mobile'],
    ['(08) 9123 4567', 'landline'],
    ['02 9876 5432', 'Sydney landline'],
    ['+61 8 9123 4567', '+61 landline'],
    ['+61 08 9123 4567', '+61 landline with the national 0 kept'],
    ['1300 975 707', '1300'],
    ['1800 123 456', '1800'],
    ['13 12 34', '13 number'],
    ['+44 7700 900123', 'genuine UK mobile'],
    ['+31 6 1234 5678', 'genuine Dutch mobile'],
    ['+1 212 555 0123', 'genuine US number'],
  ])('still accepts %s (%s)', (input) => {
    expect(isValidPhone(input)).toBe(true)
  })
})

describe('isSmsCapable — AU mobile only (drives the "won\'t receive SMS" hint)', () => {
  it.each([
    '0412345678',
    '+61412345678',
    '0412 345 678',
    '+61 0412 345 678', // national zero retained after country code — common paste format
    '0412.345.678', // dot separators
    '0061412345678', // 00 international prefix
    '61412345678', // country code without +
  ])('true for mobile %s', (input) => {
    expect(isSmsCapable(input)).toBe(true)
  })

  it.each([
    ['08 91234567', 'landline'],
    ['1300 975 707', '1300'],
    ['', 'empty'],
    ['0412 345 6', 'incomplete mobile'],
  ])('false for %s (%s)', (input) => {
    expect(isSmsCapable(input)).toBe(false)
  })
})

describe('canonicaliseAuMobile — ONE mobile detection for UI hint AND store path', () => {
  it.each([
    ['0412 345 678', '+61412345678'],
    ['+61 0412 345 678', '+61412345678'], // would otherwise store invalid +610…
    ['0412.345.678', '+61412345678'], // would otherwise store national format
    ['0061412345678', '+61412345678'],
    ['61412345678', '+61412345678'],
    // Live leaks found 18/10/2026 — stored raw, so the resident got no SMS:
    ['412 345 678', '+61412345678'], // typed without the 0 (~45 residents)
    ['+44 412 345 678', '+61412345678'], // browser autofill, UK region (no UK number is +44 4 + 8)
    ['+1 0412 345 678', '+61412345678'], // browser autofill, US region (no NANP number starts 0)
  ])('canonicalises %s → %s', (input, expected) => {
    expect(canonicaliseAuMobile(input)).toBe(expected)
  })

  it.each([
    ['(08) 9123 4567', 'landline'],
    ['1300 975 707', '1300'],
    ['abc', 'junk'],
    ['+44 7700 900 123', 'genuine UK mobile'],
    ['+41 44 123 45 67', 'genuine Swiss (Zurich) number'],
    ['4123 4567', 'mobile a digit short'],
    ['4123 456 789', 'mobile a digit long'],
  ])('returns null for %s (%s) so the store path falls back to normalisePhone', (input) => {
    expect(canonicaliseAuMobile(input)).toBeNull()
  })
})

describe('normalisePhone — strips formatting, preserves leading +', () => {
  it('strips spaces and brackets from a landline', () => {
    expect(normalisePhone('(08) 9123 4567')).toBe('0891234567')
  })

  it('preserves a leading + on an international number', () => {
    expect(normalisePhone('+61 412 345 678')).toBe('+61412345678')
  })
})

// Confirms the reused helper the server action canonicalises with (Eng F1).
describe('normaliseAuMobile — the E.164 canonicaliser reused on store', () => {
  it('converts a national mobile to E.164', () => {
    expect(normaliseAuMobile('0412 345 678')).toBe('+61412345678')
  })

  it('returns null for a landline (so the store path falls back to normalisePhone)', () => {
    expect(normaliseAuMobile('(08) 9123 4567')).toBeNull()
  })
})
