import { describe, it, expect } from 'vitest'
import {
  extractStreetNumberToken,
  streetNumbersDisagree,
  stripPremisePrefix,
  localitiesConflict,
  verifyGeocodeResult,
  type GeocodeResultShape,
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

describe('stripPremisePrefix', () => {
  it('strips a leading unit word (legacy behaviour)', () => {
    expect(stripPremisePrefix('Unit 1/504 Stirling Hwy, Peppermint Grove WA 6011, Australia')).toBe(
      '1/504 Stirling Hwy, Peppermint Grove WA 6011, Australia'
    )
    expect(stripPremisePrefix('Flat 2/16 Marine Pde, Cottesloe WA 6011, Australia')).toBe(
      '2/16 Marine Pde, Cottesloe WA 6011, Australia'
    )
  })

  it('strips a named-premise segment ahead of a Unit-word street segment (BR-0035)', () => {
    expect(
      stripPremisePrefix(
        'Peppermint Close, Unit 1/504 Stirling Hwy, Peppermint Grove WA 6011, Australia'
      )
    ).toBe('1/504 Stirling Hwy, Peppermint Grove WA 6011, Australia')
  })

  it('strips a named-premise segment ahead of a Villa-word street segment', () => {
    expect(
      stripPremisePrefix('Salvado Villas, Villa 1/5 Salvado St, Cottesloe WA 6011, Australia')
    ).toBe('1/5 Salvado St, Cottesloe WA 6011, Australia')
  })

  it('strips a named-premise segment ahead of a numbered street segment', () => {
    expect(
      stripPremisePrefix('Harbour View, 2/16 Marine Pde, Cottesloe WA 6011, Australia')
    ).toBe('2/16 Marine Pde, Cottesloe WA 6011, Australia')
  })

  it('still strips a unit word ahead of a lettered unit number', () => {
    expect(stripPremisePrefix('Unit B/41 Harvest Rd, North Fremantle WA 6159, Australia')).toBe(
      'B/41 Harvest Rd, North Fremantle WA 6159, Australia'
    )
  })

  it('strips a premise NAMED with a unit word (Villa Roma) without mangling it', () => {
    expect(
      stripPremisePrefix('Villa Roma, 5 Marine Pde, Cottesloe WA 6011, Australia')
    ).toBe('5 Marine Pde, Cottesloe WA 6011, Australia')
  })

  it('leaves a street named like a premise untouched (starts with the house number)', () => {
    expect(
      stripPremisePrefix('12 Peppermint Close, Peppermint Grove WA 6011, Australia')
    ).toBe('12 Peppermint Close, Peppermint Grove WA 6011, Australia')
  })

  it('leaves a Lot-prefix address untouched (next segment is the suburb, not a street)', () => {
    expect(stripPremisePrefix('Lot 12 Casserley Way, Orelia WA')).toBe(
      'Lot 12 Casserley Way, Orelia WA'
    )
  })

  it('leaves a named rural property untouched (no street segment follows)', () => {
    expect(stripPremisePrefix('The Old Farm, Wellard WA')).toBe('The Old Farm, Wellard WA')
    expect(stripPremisePrefix('The Old Farm')).toBe('The Old Farm')
  })
})

describe('localitiesConflict', () => {
  // The live incident: "12 Smith St Perth" — Google reads "Perth" as the metro
  // area and returns Smith St in Beaconsfield (same street number).
  it('flags a same-number street in a different suburb', () => {
    expect(localitiesConflict('12 Smith St Perth', 'Beaconsfield')).toBe(true)
    expect(localitiesConflict('10 Edith ST PERTH', 'Darlington')).toBe(true)
  })

  it('accepts the same suburb regardless of case and punctuation', () => {
    expect(localitiesConflict('12 Smith ST PERTH', 'Perth')).toBe(false)
    expect(localitiesConflict('12 Smith St, Perth WA 6000', 'Perth')).toBe(false)
  })

  it('is tolerant of Google locality-naming quirks (word overlap)', () => {
    expect(localitiesConflict('79 South Terrace SOUTH PERTH', 'Perth')).toBe(false)
    expect(localitiesConflict('1 Fortview RD MT CLAREMONT', 'Mount Claremont')).toBe(false)
    expect(localitiesConflict('4 Berwick Street ST JAMES', 'St James')).toBe(false)
  })

  it('never lets a street-type "St" satisfy a "St James" locality', () => {
    expect(localitiesConflict('12 Smith St Perth', 'St James')).toBe(true)
  })

  it('cannot verify when the input has nothing after its street type (no suburb)', () => {
    // "Pakenham" is the street name, not a suburb — must not read as a conflict.
    expect(localitiesConflict('45 Pakenham St', 'Fremantle')).toBe(false)
    expect(localitiesConflict('45 Pakenham St ', 'Beaconsfield')).toBe(false)
  })

  it('cannot verify when Google returns no locality or the input is empty', () => {
    expect(localitiesConflict('12 Smith St Perth', null)).toBe(false)
    expect(localitiesConflict('', 'Fremantle')).toBe(false)
  })

  it('reads the suburb from the comma segment when the input is comma-form', () => {
    expect(localitiesConflict('13A Epping Way, Wellard WA 6170', 'Wellard')).toBe(false)
    expect(localitiesConflict('13A Epping Way, Wellard WA 6170', 'Parmelia')).toBe(true)
  })

  it('ignores a directional suffix after the street type', () => {
    expect(localitiesConflict('4D Rennie Crescent North HILTON', 'Hilton')).toBe(false)
  })
})

describe('verifyGeocodeResult', () => {
  const street = (over: Partial<GeocodeResultShape>): GeocodeResultShape => ({
    formattedAddress: '12 Smith St, Perth WA 6000, Australia',
    types: ['street_address'],
    locationType: 'ROOFTOP',
    locality: 'Perth',
    state: 'WA',
    ...over,
  })

  it('accepts an exact same-number, same-suburb, in-state street result', () => {
    expect(verifyGeocodeResult('12 Smith ST PERTH', street({}))).toEqual({ verdict: 'ok' })
  })

  // 12 Smith St Perth → Beaconsfield (VIN-MUD-104, 29/07/2026): the crew would
  // have been routed 15 km away and the row took the real Beaconsfield
  // property's place_id.
  it('rejects a same-number result in a different suburb (locality)', () => {
    expect(
      verifyGeocodeResult(
        '12 Smith St Perth',
        street({
          formattedAddress: '12 Smith St, Beaconsfield WA 6162, Australia',
          locality: 'Beaconsfield',
        })
      )
    ).toEqual({ verdict: 'rejected', reason: 'locality' })
  })

  it('rejects an interstate result even when the suburb name agrees (state)', () => {
    expect(
      verifyGeocodeResult(
        '10 Market ST KENSINGTON',
        street({
          formattedAddress: '10 Market St, Kensington VIC 3031, Australia',
          locality: 'Kensington',
          state: 'VIC',
        })
      )
    ).toEqual({ verdict: 'rejected', reason: 'state' })
  })

  it('rejects a locality-only result (no premise) — granularity', () => {
    expect(
      verifyGeocodeResult('13A Epping Way Wellard', {
        formattedAddress: 'Wellard WA 6170, Australia',
        types: ['locality', 'political'],
        locationType: 'APPROXIMATE',
        locality: 'Wellard',
        state: 'WA',
      })
    ).toEqual({ verdict: 'rejected', reason: 'granularity' })
  })

  it('rejects a country-level result — granularity', () => {
    expect(
      verifyGeocodeResult('19 Gali LA CITY BEACH', {
        formattedAddress: 'Australia',
        types: ['country', 'political'],
        locationType: 'APPROXIMATE',
        locality: null,
        state: null,
      })
    ).toEqual({ verdict: 'rejected', reason: 'granularity' })
  })

  it('accepts a range-interpolated street result (address-level precision)', () => {
    expect(
      verifyGeocodeResult(
        '12 Smith ST PERTH',
        street({ types: ['street_address'], locationType: 'RANGE_INTERPOLATED' })
      )
    ).toEqual({ verdict: 'ok' })
  })

  it('accepts a subpremise (unit) result', () => {
    expect(
      verifyGeocodeResult(
        '5/123 Broome St COTTESLOE',
        street({
          formattedAddress: '5/123 Broome St, Cottesloe WA 6011, Australia',
          types: ['subpremise'],
          locality: 'Cottesloe',
        })
      )
    ).toEqual({ verdict: 'ok' })
  })

  it('still reports a parent-parcel snap as snapped (coords-only write)', () => {
    expect(
      verifyGeocodeResult(
        '16A Bolsover st, Wellard WA 6170',
        street({
          formattedAddress: '16 Bolsover St, Wellard WA 6170, Australia',
          locality: 'Wellard',
        })
      )
    ).toEqual({ verdict: 'snapped' })
  })

  it('rejection beats snapped: a wrong-suburb result with a different number is rejected', () => {
    expect(
      verifyGeocodeResult(
        '16A Bolsover st, Wellard WA 6170',
        street({
          formattedAddress: '16 Bolsover St, Beaconsfield WA 6162, Australia',
          locality: 'Beaconsfield',
        })
      )
    ).toEqual({ verdict: 'rejected', reason: 'locality' })
  })

  it('stays permissive when Google returns no locality or state (cannot verify)', () => {
    expect(
      verifyGeocodeResult('12 Smith ST PERTH', street({ locality: null, state: null }))
    ).toEqual({ verdict: 'ok' })
  })

  it('stays permissive when the input carries no suburb', () => {
    expect(
      verifyGeocodeResult(
        '45 Pakenham St ',
        street({
          formattedAddress: '45 Pakenham St, Fremantle WA 6160, Australia',
          locality: 'Fremantle',
        })
      )
    ).toEqual({ verdict: 'ok' })
  })
})
