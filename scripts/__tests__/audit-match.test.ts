import { describe, it, expect } from 'vitest'
import { findMissingByPropertyDate, findMissingByRef, type PropDatedRow } from '../lib/audit-match'

type Row = PropDatedRow & { ref: string }
const row = (ref: string, propertyKey: string, date: string): Row => ({ ref, propertyKey, date })

describe('findMissingByPropertyDate', () => {
  it('matches an exact property+date — not missing', () => {
    const verco = new Map([['recP1', ['2026-07-13']]])
    expect(findMissingByPropertyDate(verco, [row('A', 'recP1', '2026-07-13')], 21)).toEqual([])
  })

  it('matches a Verco booking rescheduled within tolerance — not missing', () => {
    const verco = new Map([['recP1', ['2026-07-20']]]) // moved +7 days in Verco
    expect(findMissingByPropertyDate(verco, [row('A', 'recP1', '2026-07-13')], 21)).toEqual([])
  })

  it('flags a source with no Verco booking at the property', () => {
    const verco = new Map<string, string[]>()
    const m = findMissingByPropertyDate(verco, [row('A', 'recP1', '2026-07-13')], 21)
    expect(m.map((r) => r.ref)).toEqual(['A'])
  })

  it('flags a source whose only Verco booking is outside tolerance (different round)', () => {
    const verco = new Map([['recP1', ['2026-10-05']]]) // 84 days away
    const m = findMissingByPropertyDate(verco, [row('A', 'recP1', '2026-07-13')], 21)
    expect(m.map((r) => r.ref)).toEqual(['A'])
  })

  it('consumes Verco dates — two sources, one Verco booking → one missing', () => {
    const verco = new Map([['recP1', ['2026-07-13']]])
    const m = findMissingByPropertyDate(verco, [row('A', 'recP1', '2026-07-13'), row('B', 'recP1', '2026-07-14')], 21)
    expect(m).toHaveLength(1)
    // A takes the exact date; B is left missing.
    expect(m[0]!.ref).toBe('B')
  })

  it('an exact match is never stolen by an earlier near match — the near source is missing', () => {
    const verco = new Map([['recP1', ['2026-07-14']]])
    const m = findMissingByPropertyDate(verco, [row('NEAR', 'recP1', '2026-07-10'), row('EXACT', 'recP1', '2026-07-14')], 21)
    expect(m.map((r) => r.ref)).toEqual(['NEAR'])
  })

  it('does not mutate the caller map', () => {
    const verco = new Map([['recP1', ['2026-07-13']]])
    findMissingByPropertyDate(verco, [row('A', 'recP1', '2026-07-13')], 21)
    expect(verco.get('recP1')).toEqual(['2026-07-13'])
  })
})

describe('findMissingByRef', () => {
  it('flags Airtable refs absent from Verco', () => {
    const verco = new Set(['KWN-100', 'KWN-101'])
    const m = findMissingByRef(verco, [{ ref: 'KWN-100' }, { ref: 'KWN-999' }])
    expect(m.map((r) => r.ref)).toEqual(['KWN-999'])
  })

  it('treats a fully-imported set as empty', () => {
    const verco = new Set(['KWN-100', 'KWN-101'])
    expect(findMissingByRef(verco, [{ ref: 'KWN-100' }, { ref: 'KWN-101' }])).toEqual([])
  })
})
