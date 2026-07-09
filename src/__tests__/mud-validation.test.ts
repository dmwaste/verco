import { describe, it, expect } from 'vitest'
import { isValidPhone, isSmsCapable, normalisePhone } from '@/lib/mud/validation'
import { normaliseAuMobile } from '@/lib/booking/schemas'

describe('isValidPhone — accepts every real AU phone format, rejects junk (VER-315)', () => {
  it.each([
    ['0412345678', 'mobile'],
    ['08 91234567', 'landline, spaced'],
    ['(08) 9123 4567', 'landline, bracketed'],
    ['9123 4567', 'bare 8-digit local'],
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
  ])('rejects %s (%s)', (input) => {
    expect(isValidPhone(input)).toBe(false)
  })
})

describe('isSmsCapable — AU mobile only (drives the "won\'t receive SMS" hint)', () => {
  it.each(['0412345678', '+61412345678', '0412 345 678'])('true for mobile %s', (input) => {
    expect(isSmsCapable(input)).toBe(true)
  })

  it.each([
    ['08 91234567', 'landline'],
    ['1300 975 707', '1300'],
    ['', 'empty'],
  ])('false for %s (%s)', (input) => {
    expect(isSmsCapable(input)).toBe(false)
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
