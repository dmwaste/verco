import { describe, expect, it } from 'vitest'

import { pickCurrentFyId } from '@/lib/reports/current-fy'

describe('pickCurrentFyId (VER-179 §5.3)', () => {
  it('returns null when the rows argument is null', () => {
    expect(pickCurrentFyId(null)).toBeNull()
  })

  it('returns null when the rows argument is undefined', () => {
    expect(pickCurrentFyId(undefined)).toBeNull()
  })

  it('returns null for an empty array', () => {
    expect(pickCurrentFyId([])).toBeNull()
  })

  it('returns null when no row is current', () => {
    expect(
      pickCurrentFyId([
        { id: 'fy-25', is_current: false },
        { id: 'fy-24', is_current: false },
      ]),
    ).toBeNull()
  })

  it('returns the id of the single current row', () => {
    expect(
      pickCurrentFyId([
        { id: 'fy-25', is_current: false },
        { id: 'fy-26', is_current: true },
        { id: 'fy-24', is_current: false },
      ]),
    ).toBe('fy-26')
  })

  it('returns the id of the current row when it is the only row', () => {
    expect(pickCurrentFyId([{ id: 'fy-26', is_current: true }])).toBe('fy-26')
  })

  it('takes the FIRST current row when multiple are current (data anomaly)', () => {
    expect(
      pickCurrentFyId([
        { id: 'fy-25', is_current: false },
        { id: 'fy-26', is_current: true },
        { id: 'fy-27', is_current: true },
      ]),
    ).toBe('fy-26')
  })

  it('ignores non-boolean-truthy is_current and only matches strict true', () => {
    // Guards against a falsy/coerced value sneaking through as "current".
    expect(
      pickCurrentFyId([
        // @ts-expect-error — exercising a malformed runtime row
        { id: 'fy-bad', is_current: 1 },
        { id: 'fy-26', is_current: true },
      ]),
    ).toBe('fy-26')
  })

  it('skips a malformed current row missing an id and falls through', () => {
    expect(
      pickCurrentFyId([
        // @ts-expect-error — exercising a malformed runtime row (no id)
        { is_current: true },
        { id: 'fy-26', is_current: true },
      ]),
    ).toBe('fy-26')
  })

  it('returns null when the only current row has no usable id', () => {
    expect(
      pickCurrentFyId([
        // @ts-expect-error — exercising a malformed runtime row (null id)
        { id: null, is_current: true },
      ]),
    ).toBeNull()
  })

  it('accepts wider rows (extra columns) and still resolves the current id', () => {
    // Mirrors a `financial_year.Row[]` (id + is_current + extra columns). A
    // typed variable — not an inline literal — so excess-property check matches
    // how the consumer passes rows.
    const rows: { id: string; is_current: boolean; label: string }[] = [
      { id: 'fy-25', is_current: false, label: 'FY25' },
      { id: 'fy-26', is_current: true, label: 'FY26' },
    ]
    expect(pickCurrentFyId(rows)).toBe('fy-26')
  })
})
