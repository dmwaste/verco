import { describe, it, expect } from 'vitest'
import { resolveAreaSuggestion } from '@/lib/booking/id-area-suggestion'

const AREA_A = 'a4d9b8c2-1111-4000-8000-000000000001'
const AREA_B = 'a4d9b8c2-2222-4000-8000-000000000002'
const OFFERED = [AREA_A, AREA_B]

describe('resolveAreaSuggestion', () => {
  it('returns none when the address matched no property', () => {
    expect(resolveAreaSuggestion(null, AREA_A, OFFERED)).toEqual({ kind: 'none' })
    expect(resolveAreaSuggestion(null, '', OFFERED)).toEqual({ kind: 'none' })
  })

  it('returns none when the matched area is not in the offered list', () => {
    // e.g. inactive area, or a sub-client-narrowed user whose dropdown
    // excludes the matched area — suggesting something unselectable is noise.
    const elsewhere = 'a4d9b8c2-9999-4000-8000-000000000009'
    expect(resolveAreaSuggestion(elsewhere, AREA_A, OFFERED)).toEqual({ kind: 'none' })
    expect(resolveAreaSuggestion(elsewhere, '', OFFERED)).toEqual({ kind: 'none' })
  })

  it('suggests the matched area when nothing is selected yet', () => {
    expect(resolveAreaSuggestion(AREA_A, '', OFFERED)).toEqual({
      kind: 'suggest',
      areaId: AREA_A,
    })
  })

  it('agrees when the selection matches the address', () => {
    expect(resolveAreaSuggestion(AREA_A, AREA_A, OFFERED)).toEqual({
      kind: 'agree',
      areaId: AREA_A,
    })
  })

  it('flags a mismatch when the selection differs from the address match', () => {
    expect(resolveAreaSuggestion(AREA_A, AREA_B, OFFERED)).toEqual({
      kind: 'mismatch',
      matchedAreaId: AREA_A,
      selectedAreaId: AREA_B,
    })
  })

  it('returns none for an empty offered list', () => {
    expect(resolveAreaSuggestion(AREA_A, AREA_A, [])).toEqual({ kind: 'none' })
  })
})
