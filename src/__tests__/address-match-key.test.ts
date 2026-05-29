import { describe, it, expect } from 'vitest'
import {
  addressMatchKey,
  buildAddressIlikePattern,
  buildEligibleOrFilter,
  normaliseStreetTypes,
  buildLookupCandidates,
} from '@/lib/booking/address-match-key'
import { stripAddressPrefix } from '@/lib/mud/address-strip'

describe('addressMatchKey', () => {
  it('keeps the first two comma parts of a 4-part address', () => {
    expect(
      addressMatchKey('10 Casserley Way, Orelia WA 6167, Australia')
    ).toBe('10 Casserley Way, Orelia WA 6167')
  })

  it('returns the single part when no comma', () => {
    expect(addressMatchKey('10 Casserley Way')).toBe('10 Casserley Way')
  })

  it('trims whitespace around comma parts', () => {
    expect(addressMatchKey('  10 X St ,  Como WA  ,  Australia ')).toBe(
      '10 X St, Como WA'
    )
  })
})

describe('normaliseStreetTypes', () => {
  it('abbreviates Street → St at the end of the first part', () => {
    expect(normaliseStreetTypes('10 Salvado Street, Wembley WA 6014')).toBe(
      '10 Salvado St, Wembley WA 6014'
    )
  })

  it('abbreviates Avenue → Ave', () => {
    expect(normaliseStreetTypes('15/10 Murray Avenue, Mosman Park WA')).toBe(
      '15/10 Murray Ave, Mosman Park WA'
    )
  })

  it('abbreviates Crescent → Cres when followed by a directional modifier', () => {
    expect(normaliseStreetTypes('4D Rennie Crescent North, Hilton WA')).toBe(
      '4D Rennie Cres North, Hilton WA'
    )
  })

  it('only normalises the street-TYPE word, not a street NAME that collides', () => {
    expect(normaliseStreetTypes('5/2 Court Place, Subiaco WA')).toBe(
      '5/2 Court Pl, Subiaco WA'
    )
  })

  it('abbreviates Way → Wy', () => {
    // ~555 properties on the KWN tenant store the Wy form; Google
    // Autocomplete returns "Way". Without this mapping those properties
    // are unreachable through the public booking flow.
    expect(normaliseStreetTypes('10 Casserley Way, Orelia WA 6167')).toBe(
      '10 Casserley Wy, Orelia WA 6167'
    )
  })

  it('abbreviates Close → Cl (regression — 3 Eliot Close, Parmelia)', () => {
    // The reported bug: resident searched "3 Eliot Close, Parmelia WA"
    // (Google Autocomplete full form). DB stores "3 Eliot Cl, Parmelia WA
    // 6167". Without close→Cl the raw lookup misses, the normalised
    // lookup is a no-op, and the property shows as ineligible despite
    // is_eligible=true on the row.
    expect(normaliseStreetTypes('3 Eliot Close, Parmelia WA 6167')).toBe(
      '3 Eliot Cl, Parmelia WA 6167'
    )
  })

  it('abbreviates Loop → Lp', () => {
    expect(normaliseStreetTypes('22 Sandalford Loop, Wellard WA')).toBe(
      '22 Sandalford Lp, Wellard WA'
    )
  })

  it('abbreviates Parkway → Pkwy', () => {
    expect(normaliseStreetTypes('5 Wellard Parkway, Wellard WA')).toBe(
      '5 Wellard Pkwy, Wellard WA'
    )
  })

  it('abbreviates Circle → Cir', () => {
    expect(normaliseStreetTypes('7 Banksia Circle, Parmelia WA')).toBe(
      '7 Banksia Cir, Parmelia WA'
    )
  })

  it('abbreviates Vista → Vis', () => {
    expect(normaliseStreetTypes('12 Ocean Vista, Wellard WA')).toBe(
      '12 Ocean Vis, Wellard WA'
    )
  })

  it('abbreviates Grove → Grv', () => {
    expect(normaliseStreetTypes('33 Banksia Grove, Wellard WA')).toBe(
      '33 Banksia Grv, Wellard WA'
    )
  })

  it('handles inputs with no comma', () => {
    expect(normaliseStreetTypes('10 Salvado Street')).toBe('10 Salvado St')
  })

  it('returns the input unchanged when no street type is present', () => {
    expect(normaliseStreetTypes('10 Some Building Name, Perth')).toBe(
      '10 Some Building Name, Perth'
    )
  })
})

describe('buildAddressIlikePattern', () => {
  // Anchoring at the start is the whole point of this helper. Regression
  // for VER-214: the previous `%{key}%` shape made "32 Lake St" match
  // "232 Lake St" because "232" contains "32".
  it('anchors the pattern at the start of formatted_address', () => {
    expect(buildAddressIlikePattern('32 Lake St, Perth WA')).toBe(
      '32 Lake St, Perth WA%'
    )
  })

  it('does NOT produce a leading wildcard (would collide on house-number substrings)', () => {
    const pattern = buildAddressIlikePattern('32 Lake St, Perth WA')
    expect(pattern.startsWith('%')).toBe(false)
  })

  it('escapes literal % so addresses with percent signs do not become wildcards', () => {
    expect(buildAddressIlikePattern('100% Pure St, Perth WA')).toBe(
      '100\\% Pure St, Perth WA%'
    )
  })

  it('escapes literal underscore (rare but possible in formatted_address)', () => {
    expect(buildAddressIlikePattern('Lot_1 X Rd, Perth')).toBe(
      'Lot\\_1 X Rd, Perth%'
    )
  })

  it('escapes backslash so an embedded backslash is literal', () => {
    expect(buildAddressIlikePattern('a\\b')).toBe('a\\\\b%')
  })

  // Simulate the actual collision against canonical formatted_address values.
  // PostgreSQL ILIKE semantics: `%` = any-N, `_` = any-one, both case-insensitive.
  function ilikeMatches(value: string, pattern: string): boolean {
    let regex = ''
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]
      if (c === '\\' && i + 1 < pattern.length) {
        const next = pattern[i + 1]
        regex += next!.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
        i++
      } else if (c === '%') {
        regex += '.*'
      } else if (c === '_') {
        regex += '.'
      } else {
        regex += c!.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
      }
    }
    return new RegExp(`^${regex}$`, 'i').test(value)
  }

  it('rejects house-number-suffix collisions (regression for VER-214)', () => {
    const pattern = buildAddressIlikePattern('32 Lake St, Perth WA')
    expect(
      ilikeMatches('32 Lake St, Perth WA 6000, Australia', pattern)
    ).toBe(true)
    expect(
      ilikeMatches('232 Lake St, Perth WA 6000, Australia', pattern)
    ).toBe(false)
    expect(
      ilikeMatches('1032 Lake St, Perth WA 6000, Australia', pattern)
    ).toBe(false)
  })
})

describe('buildEligibleOrFilter', () => {
  // Regression: the public booking flow's ILIKE fallback assembled the
  // .or() string by interpolating the raw pattern. The formatted_address
  // key is always two comma-parts ("<street>, <suburb>"), so the bare comma
  // was read by PostgREST as the separator BETWEEN .or() conditions →
  // PGRST100 "failed to parse logic tree" (HTTP 400) → data:null → an
  // eligible address shown as "not eligible". Live repro: "1 Baring St,
  // Mosman Park". Double-quoting each value makes the comma literal.
  it('wraps the comma-bearing formatted_address pattern in double quotes', () => {
    expect(
      buildEligibleOrFilter('1 Baring St, Mosman Park WA 6012%', '1 Baring St%')
    ).toBe(
      'formatted_address.ilike."1 Baring St, Mosman Park WA 6012%",address.ilike."1 Baring St%"'
    )
  })

  it('quotes both operands even when neither contains a comma', () => {
    expect(buildEligibleOrFilter('10 Eagle Heights%', '10 Eagle Heights%')).toBe(
      'formatted_address.ilike."10 Eagle Heights%",address.ilike."10 Eagle Heights%"'
    )
  })

  it('escapes embedded double-quotes and backslashes inside the quoted value', () => {
    // Defensive: PostgREST treats " and \ as special inside a quoted value.
    // Real WA addresses never contain them, but buildAddressIlikePattern can
    // emit a backslash when escaping a literal % / _ in an address.
    expect(buildEligibleOrFilter('a"b%', 'c\\d%')).toBe(
      'formatted_address.ilike."a\\"b%",address.ilike."c\\\\d%"'
    )
  })
})

describe('buildLookupCandidates', () => {
  it('returns [raw] when no transform applies', () => {
    // "Heights" isn't in STREET_TYPES (DB stores both forms; raw lookup
    // handles either). Replaces the prior Casserley-Way case since Way is
    // now mapped to Wy.
    expect(
      buildLookupCandidates(
        '10 Eagle Heights, Wellard WA 6170',
        stripAddressPrefix
      )
    ).toEqual(['10 Eagle Heights, Wellard WA 6170'])
  })

  it('returns [raw, stripped, normalised, both] for MUD-prefixed inputs with abbreviable street types', () => {
    // Way → Wy is now in the map, so this case now produces all four
    // variants (raw, stripped, normalised, both).
    expect(
      buildLookupCandidates(
        'Unit 5 / 18 Sulphur Way, Kwinana',
        stripAddressPrefix
      )
    ).toEqual([
      'Unit 5 / 18 Sulphur Way, Kwinana',
      '18 Sulphur Way, Kwinana',
      'Unit 5 / 18 Sulphur Wy, Kwinana',
      '18 Sulphur Wy, Kwinana',
    ])
  })

  it('returns [raw, normalised] for non-MUD inputs with abbreviable street types', () => {
    expect(
      buildLookupCandidates(
        '10 Salvado Street, Wembley WA 6014',
        stripAddressPrefix
      )
    ).toEqual([
      '10 Salvado Street, Wembley WA 6014',
      '10 Salvado St, Wembley WA 6014',
    ])
  })

  it('returns all four variants when both transforms apply', () => {
    const out = buildLookupCandidates(
      'Unit 5/18 Sulphur Road, Kwinana',
      stripAddressPrefix
    )
    expect(out[0]).toBe('Unit 5/18 Sulphur Road, Kwinana')
    expect(out).toContain('18 Sulphur Road, Kwinana')
    expect(out).toContain('Unit 5/18 Sulphur Rd, Kwinana')
    expect(out).toContain('18 Sulphur Rd, Kwinana')
  })

  it('deduplicates when transforms produce the same string', () => {
    // No prefix to strip and no abbreviable street type — single candidate.
    const out = buildLookupCandidates('10 Eagle Heights, Perth', stripAddressPrefix)
    expect(out).toEqual(['10 Eagle Heights, Perth'])
  })
})
