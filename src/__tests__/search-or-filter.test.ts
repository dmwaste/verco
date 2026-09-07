import { describe, it, expect } from 'vitest'
import { buildSearchOrFilter, buildSearchOrFilterWithEnum } from '@/lib/search/or-filter'

describe('buildSearchOrFilter', () => {
  it('builds a quoted contains filter across multiple columns', () => {
    expect(buildSearchOrFilter(['address', 'formatted_address'], 'baring')).toBe(
      'address.ilike."%baring%",formatted_address.ilike."%baring%"'
    )
  })

  it('keeps a comma in the term INSIDE the quotes (the regression)', () => {
    // Before quoting, a comma in the term ("Smith, John") was read by PostgREST
    // as the separator between .or() conditions → PGRST100 400 → empty results.
    expect(buildSearchOrFilter(['notes', 'reason'], 'Smith, John')).toBe(
      'notes.ilike."%Smith, John%",reason.ilike."%Smith, John%"'
    )
  })

  it('handles a single column', () => {
    expect(buildSearchOrFilter(['reason'], 'duplicate')).toBe(
      'reason.ilike."%duplicate%"'
    )
  })

  it('preserves embed-prefixed column paths', () => {
    expect(
      buildSearchOrFilter(['profiles.email', 'profiles.display_name'], 'dan')
    ).toBe(
      'profiles.email.ilike."%dan%",profiles.display_name.ilike."%dan%"'
    )
  })

  it('escapes embedded double-quotes and backslashes in the term', () => {
    expect(buildSearchOrFilter(['notes'], 'a"b\\c')).toBe(
      'notes.ilike."%a\\"b\\\\c%"'
    )
  })

  it('leaves LIKE wildcards in the term as wildcards (unchanged contains behaviour)', () => {
    expect(buildSearchOrFilter(['ref'], '50%')).toBe('ref.ilike."%50%%"')
  })
})

describe('buildSearchOrFilterWithEnum (#497 — enum columns cannot be ILIKEd)', () => {
  const REASONS = ['Building Waste', 'Asbestos / Fibre Fence', 'Tyres', 'Other'] as const

  it('text columns get ilike; matching enum values become a quoted .in. list', () => {
    expect(buildSearchOrFilterWithEnum(['notes'], 'reason', REASONS, 'asbes')).toBe(
      'notes.ilike."%asbes%",reason.in.("Asbestos / Fibre Fence")',
    )
  })

  it('matches are case-insensitive substring and may be several', () => {
    expect(buildSearchOrFilterWithEnum(['notes'], 'reason', REASONS, 'e')).toBe(
      'notes.ilike."%e%",reason.in.("Building Waste","Asbestos / Fibre Fence","Tyres","Other")',
    )
  })

  it('no enum match → plain text filter only (never an ilike on the enum)', () => {
    const f = buildSearchOrFilterWithEnum(['notes'], 'reason', REASONS, 'zzz')
    expect(f).toBe('notes.ilike."%zzz%"')
    expect(f).not.toContain('reason')
  })

  it('commas/quotes in the term stay literal in the ilike and cannot break the .in. list', () => {
    expect(buildSearchOrFilterWithEnum(['notes'], 'reason', REASONS, 'a, "b"')).toBe(
      'notes.ilike."%a, \\"b\\"%"',
    )
  })
})
