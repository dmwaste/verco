import { describe, it, expect } from 'vitest'
import { finiteCoord } from '@/lib/booking/finite-coord'

// Guards the /book property map against bad eligible_properties geocode data.
// The generated type says number | null, but numeric columns arrive as strings
// on some fetch paths (CLAUDE.md §2 Maps row), and the importer is documented
// as still emitting bad rows — so the input is treated as untrusted.
describe('finiteCoord', () => {
  it('accepts finite numbers', () => {
    expect(finiteCoord(-32.24)).toBe(-32.24)
    expect(finiteCoord(115.75)).toBe(115.75)
    expect(finiteCoord(0)).toBe(0)
  })

  it('accepts numeric strings (Postgres numeric arrives as string on some paths)', () => {
    expect(finiteCoord('-32.24')).toBe(-32.24)
    expect(finiteCoord('115.75')).toBe(115.75)
  })

  it('rejects empty and whitespace strings — Number("") is 0, a silent 0,0 pin', () => {
    expect(finiteCoord('')).toBeNull()
    expect(finiteCoord('   ')).toBeNull()
  })

  it('rejects garbage and non-finite values', () => {
    expect(finiteCoord('junk')).toBeNull()
    expect(finiteCoord('NaN')).toBeNull()
    expect(finiteCoord('Infinity')).toBeNull()
    expect(finiteCoord(NaN)).toBeNull()
    expect(finiteCoord(Infinity)).toBeNull()
  })

  it('rejects null, undefined and non string/number types', () => {
    expect(finiteCoord(null)).toBeNull()
    expect(finiteCoord(undefined)).toBeNull()
    expect(finiteCoord(true)).toBeNull() // Number(true) is 1 — must not pass
    expect(finiteCoord(['-32.24'])).toBeNull() // Number(['-32.24']) is -32.24 — must not pass
    expect(finiteCoord({})).toBeNull()
  })
})
