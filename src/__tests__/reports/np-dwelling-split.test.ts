import { describe, it, expect } from 'vitest'
import { computeNpDwellingSplit } from '@/lib/reports/np-dwelling-split'

describe('computeNpDwellingSplit (#459)', () => {
  it('splits MUD vs standard', () => {
    const split = computeNpDwellingSplit([
      { is_mud: true },
      { is_mud: true },
      { is_mud: false },
    ])
    expect(split).toEqual({ mud: 2, standard: 1 })
  })

  it('counts a property-less notice as standard, never dropped (total must match notice count)', () => {
    const split = computeNpDwellingSplit([{ is_mud: null }, { is_mud: true }])
    expect(split).toEqual({ mud: 1, standard: 1 })
    expect(split.mud + split.standard).toBe(2)
  })

  it('returns zeros for an empty period', () => {
    expect(computeNpDwellingSplit([])).toEqual({ mud: 0, standard: 0 })
  })
})
