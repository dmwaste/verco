import { describe, it, expect } from 'vitest'
import {
  geocodedSuburb,
  addressMatchesSuburb,
  preferSuburbConsistent,
  dedupeByPlaceId,
} from '../lib/dedupe-properties'
import type { EligiblePropertyInsert } from '../lib/types'

const areaId = '00000000-0000-0000-0000-000000000001'

function row(
  partial: Partial<EligiblePropertyInsert> & { external_id: string }
): EligiblePropertyInsert {
  return {
    collection_area_id: areaId,
    address: '',
    formatted_address: null,
    latitude: null,
    longitude: null,
    google_place_id: null,
    has_geocode: false,
    is_mud: false,
    external_source: 'airtable:appTEST',
    ...partial,
  }
}

// The real 6 Grant St duplicate pair (same place_id, one correct, one mis-coded).
const grantCottesloe = row({
  external_id: 'reckESElGazHzXbCd',
  address: '6 Grant Street COTTESLOE WA 6011',
  formatted_address: '6 Grant St, Cottesloe WA 6011, Australia',
  google_place_id: 'ChIJUz_DpYOmMioR4Ra1b_zsDxk',
})
const grantPerth = row({
  external_id: 'rec13QhNeUJv3BNRs',
  address: '6 Grant ST PERTH',
  formatted_address: '6 Grant St, Cottesloe WA 6011, Australia',
  google_place_id: 'ChIJUz_DpYOmMioR4Ra1b_zsDxk',
})

describe('geocodedSuburb', () => {
  it('extracts the suburb from a Google formatted_address', () => {
    expect(geocodedSuburb('6 Grant St, Cottesloe WA 6011, Australia')).toBe('Cottesloe')
  })
  it('handles a multi-word suburb', () => {
    expect(geocodedSuburb('4 Hope St, White Gum Valley WA 6162, Australia')).toBe('White Gum Valley')
  })
  it('returns null for the junk "Australia"-only geocode', () => {
    expect(geocodedSuburb('Australia')).toBeNull()
  })
  it('returns null for null input', () => {
    expect(geocodedSuburb(null)).toBeNull()
  })
})

describe('addressMatchesSuburb', () => {
  it('is true when the address contains the geocoded suburb', () => {
    expect(addressMatchesSuburb(grantCottesloe)).toBe(true)
  })
  it('is false for the mis-sourced "… PERTH" row', () => {
    expect(addressMatchesSuburb(grantPerth)).toBe(false)
  })
  it('is true (no signal) when the suburb cannot be derived', () => {
    expect(addressMatchesSuburb(row({ external_id: 'x', address: 'foo', formatted_address: 'Australia' }))).toBe(true)
  })
})

describe('preferSuburbConsistent', () => {
  it('keeps the suburb-consistent row regardless of order', () => {
    expect(preferSuburbConsistent(grantPerth, grantCottesloe)).toBe(grantCottesloe)
    expect(preferSuburbConsistent(grantCottesloe, grantPerth)).toBe(grantCottesloe)
  })
  it('keeps the first row on a tie', () => {
    expect(preferSuburbConsistent(grantCottesloe, grantCottesloe)).toBe(grantCottesloe)
  })
})

describe('dedupeByPlaceId', () => {
  it('collapses the 6 Grant St pair to the correct (Cottesloe) row', () => {
    const seen = new Set<string>()
    const res = dedupeByPlaceId([grantPerth, grantCottesloe], seen)
    expect(res.kept).toEqual([grantCottesloe])
    expect(res.droppedInBatch).toEqual([grantPerth])
    expect(res.droppedExisting).toEqual([])
    expect(seen.has('ChIJUz_DpYOmMioR4Ra1b_zsDxk')).toBe(true)
  })

  it('drops a row whose place_id already exists in Verco', () => {
    const seen = new Set<string>(['ChIJUz_DpYOmMioR4Ra1b_zsDxk'])
    const res = dedupeByPlaceId([grantCottesloe], seen)
    expect(res.kept).toEqual([])
    expect(res.droppedExisting).toEqual([grantCottesloe])
  })

  it('passes through un-geocoded rows (null place_id) without dedup', () => {
    const a = row({ external_id: 'a', address: '1 Main St', google_place_id: null })
    const b = row({ external_id: 'b', address: '1 Main St', google_place_id: null })
    const res = dedupeByPlaceId([a, b], new Set())
    expect(res.kept).toEqual([a, b])
    expect(res.droppedInBatch).toEqual([])
  })

  it('keeps distinct properties (different place_ids)', () => {
    const a = row({ external_id: 'a', address: '1 A St, Como WA', formatted_address: '1 A St, Como WA 6152, Australia', google_place_id: 'pidA' })
    const b = row({ external_id: 'b', address: '2 B St, Como WA', formatted_address: '2 B St, Como WA 6152, Australia', google_place_id: 'pidB' })
    const res = dedupeByPlaceId([a, b], new Set())
    expect(res.kept).toHaveLength(2)
    expect(res.droppedInBatch).toEqual([])
  })

  it('dedups across bases via the mutated seen-set', () => {
    const seen = new Set<string>()
    const first = dedupeByPlaceId([grantCottesloe], seen) // base 1
    const second = dedupeByPlaceId([grantPerth], seen)    // base 2, same property
    expect(first.kept).toEqual([grantCottesloe])
    expect(second.kept).toEqual([])
    expect(second.droppedExisting).toEqual([grantPerth])
  })
})
