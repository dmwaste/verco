import { describe, it, expect } from 'vitest'
import {
  extractStreetNumberToken,
  streetNumbersDisagree,
} from '@/lib/booking/geocode-verify'

describe('extractStreetNumberToken', () => {
  it('extracts a plain house number', () => {
    expect(extractStreetNumberToken('16 Bolsover st, Wellard WA 6170')).toBe('16')
  })

  it('extracts a lettered subdivision number, uppercased', () => {
    expect(extractStreetNumberToken('16a Bolsover st, Wellard WA 6170')).toBe('16A')
  })

  it('extracts a unit/lot compound number', () => {
    expect(extractStreetNumberToken('5/123 Broome St, Cottesloe WA')).toBe('5/123')
  })

  it('skips leading non-numeric words (Lot prefix)', () => {
    expect(extractStreetNumberToken('Lot 12 Casserley Way, Orelia WA')).toBe('12')
  })

  it('ignores digits outside the street segment (postcode after comma)', () => {
    expect(extractStreetNumberToken('Bolsover St, Wellard WA 6170')).toBeNull()
  })

  it('returns null when there is no number at all', () => {
    expect(extractStreetNumberToken('The Old Farm')).toBeNull()
  })
})

describe('streetNumbersDisagree', () => {
  // The live incident: Google doesn't know the subdivided lot yet and snaps
  // "16A" to the parent parcel "16" — the geocoder must NOT adopt that result.
  it('flags a subdivision snapped to its parent parcel', () => {
    expect(
      streetNumbersDisagree(
        '16A Bolsover st, Wellard WA 6170',
        '16 Bolsover st, Wellard WA 6170, Australia'
      )
    ).toBe(true)
  })

  it('accepts an exact same-number geocode', () => {
    expect(
      streetNumbersDisagree(
        '16 Bolsover st, Wellard WA 6170',
        '16 Bolsover St, Wellard WA 6170, Australia'
      )
    ).toBe(false)
  })

  it('is case-insensitive on the letter suffix', () => {
    expect(
      streetNumbersDisagree(
        '16a Bolsover st, Wellard WA 6170',
        '16A Bolsover St, Wellard WA 6170, Australia'
      )
    ).toBe(false)
  })

  it('flags a unit address collapsed to the base building', () => {
    expect(
      streetNumbersDisagree('5/18 Sulphur Rd, Kwinana WA', '18 Sulphur Rd, Kwinana WA')
    ).toBe(true)
  })

  it('accepts matching unit compound numbers', () => {
    expect(
      streetNumbersDisagree(
        '5/123 Broome St, Cottesloe WA',
        '5/123 Broome St, Cottesloe WA 6011, Australia'
      )
    ).toBe(false)
  })

  it('stays permissive when either side has no street number (cannot verify)', () => {
    expect(
      streetNumbersDisagree('The Old Farm, Wellard WA', '16 Bolsover St, Wellard WA')
    ).toBe(false)
    expect(
      streetNumbersDisagree('16 Bolsover St, Wellard WA', 'Wellard WA, Australia')
    ).toBe(false)
  })
})
