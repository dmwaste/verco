import { describe, it, expect } from 'vitest'
import { stripAddressPrefix, stripUnitNumber } from '@/lib/mud/address-strip'

describe('stripAddressPrefix', () => {
  it('strips Unit X / prefix', () => {
    expect(stripAddressPrefix('Unit 5 / 123 Broome St, Cottesloe')).toBe(
      '123 Broome St, Cottesloe'
    )
  })

  it('strips U X without slash', () => {
    expect(stripAddressPrefix('U 12 123 Broome St')).toBe('123 Broome St')
  })

  it('strips U12/ compact form', () => {
    expect(stripAddressPrefix('U12/123 Broome St')).toBe('123 Broome St')
  })

  it('strips Apt with letter suffix', () => {
    expect(stripAddressPrefix('Apt 5A, 123 Broome St')).toBe('123 Broome St')
  })

  it('strips Apt. with period', () => {
    expect(stripAddressPrefix('Apt. 5, 123 Broome St')).toBe('123 Broome St')
  })

  it('strips Apartment full word', () => {
    expect(stripAddressPrefix('Apartment 5, 123 Broome St')).toBe('123 Broome St')
  })

  it('strips Flat prefix', () => {
    expect(stripAddressPrefix('Flat 2 123 Broome St')).toBe('123 Broome St')
  })

  it('strips Lot with hyphenated number', () => {
    expect(stripAddressPrefix('Lot 4-6 Main Rd')).toBe('Main Rd')
  })

  it('strips Townhouse with slash', () => {
    expect(stripAddressPrefix('Townhouse 3/45 Broome St')).toBe('45 Broome St')
  })

  it('strips Villa with comma', () => {
    expect(stripAddressPrefix('Villa 8, 123 Broome St')).toBe('123 Broome St')
  })

  it('strips Shop prefix', () => {
    expect(stripAddressPrefix('Shop 2, 123 Broome St')).toBe('123 Broome St')
  })

  it('strips Suite prefix', () => {
    expect(stripAddressPrefix('Suite 100, 123 Broome St')).toBe('123 Broome St')
  })

  it('strips # prefix', () => {
    expect(stripAddressPrefix('#5 / 123 Broome St')).toBe('123 Broome St')
  })

  it('leaves plain address unchanged (no prefix)', () => {
    expect(stripAddressPrefix('123 Broome St')).toBe('123 Broome St')
  })

  it('leaves "4/12 Broome St" unchanged (no keyword, just slash)', () => {
    expect(stripAddressPrefix('4/12 Broome St')).toBe('4/12 Broome St')
  })

  it('handles lowercase input', () => {
    expect(stripAddressPrefix('unit 5 / 123 broome st')).toBe('123 broome st')
  })

  it('handles mixed case', () => {
    expect(stripAddressPrefix('UnIt 5 / 123 Broome St')).toBe('123 Broome St')
  })

  it('handles extra leading whitespace', () => {
    expect(stripAddressPrefix('   UNIT 5 / 123 Broome St')).toBe('123 Broome St')
  })

  it('handles empty string', () => {
    expect(stripAddressPrefix('')).toBe('')
  })

  it('handles whitespace-only input', () => {
    expect(stripAddressPrefix('   ')).toBe('   ')
  })
})

describe('stripUnitNumber', () => {
  it('strips a bare unit number from a geocoded address', () => {
    expect(stripUnitNumber('4/12 Broome St, Cottesloe WA 6011, Australia')).toBe(
      '12 Broome St, Cottesloe WA 6011, Australia'
    )
  })

  it('strips a unit number with a letter suffix', () => {
    expect(stripUnitNumber('12A/633 Fixture Street JOLIMONT')).toBe(
      '633 Fixture Street JOLIMONT'
    )
  })

  it('strips spacing around the slash', () => {
    expect(stripUnitNumber('  3 / 12 Broome St')).toBe('12 Broome St')
  })

  it('leaves a plain address unchanged', () => {
    expect(stripUnitNumber('12 Broome St')).toBe('12 Broome St')
  })

  it('leaves a street-number range unchanged', () => {
    expect(stripUnitNumber('12-14 Broome St')).toBe('12-14 Broome St')
  })

  it('leaves the keyword form to stripAddressPrefix', () => {
    expect(stripUnitNumber('Unit 5 / 123 Broome St')).toBe('Unit 5 / 123 Broome St')
  })

  it('handles empty string', () => {
    expect(stripUnitNumber('')).toBe('')
  })
})
