import { describe, it, expect } from 'vitest'
import { compareCursor, isAfterCursor } from '@/lib/hubspot/cursor'

const T1 = '2026-05-01T00:00:00.000Z'
const T2 = '2026-05-02T00:00:00.000Z'

describe('compareCursor — (updated_at, id)', () => {
  it('orders by updated_at first', () => {
    expect(compareCursor({ updated_at: T1, id: 'z' }, { updated_at: T2, id: 'a' })).toBeLessThan(0)
    expect(compareCursor({ updated_at: T2, id: 'a' }, { updated_at: T1, id: 'z' })).toBeGreaterThan(0)
  })

  it('breaks same-timestamp ties by id (so equal-updated_at rows are never skipped)', () => {
    expect(compareCursor({ updated_at: T1, id: 'a' }, { updated_at: T1, id: 'b' })).toBeLessThan(0)
    expect(compareCursor({ updated_at: T1, id: 'b' }, { updated_at: T1, id: 'a' })).toBeGreaterThan(0)
  })

  it('returns 0 for identical cursors', () => {
    expect(compareCursor({ updated_at: T1, id: 'a' }, { updated_at: T1, id: 'a' })).toBe(0)
  })

  it('compares updated_at chronologically, not lexicographically (VER-239 §11c)', () => {
    // '...00Z' text-sorts AFTER '...00.5Z' (Z=0x5A > .=0x2E) but is chronologically BEFORE it.
    // A lexicographic compare here mis-orders and the cursor would silently skip a row.
    const whole = { updated_at: '2026-05-01T00:00:00Z', id: 'a' }
    const frac = { updated_at: '2026-05-01T00:00:00.500Z', id: 'a' }
    expect(compareCursor(whole, frac)).toBeLessThan(0)
    expect(compareCursor(frac, whole)).toBeGreaterThan(0)

    // Same instant, different serialization (Z vs +00:00) → equal on updated_at, tiebreak on id.
    const zulu = { updated_at: '2026-05-01T00:00:00.000Z', id: 'a' }
    const offset = { updated_at: '2026-05-01T00:00:00.000+00:00', id: 'a' }
    expect(compareCursor(zulu, offset)).toBe(0)
  })
})

describe('isAfterCursor', () => {
  it('is true only for rows strictly after the cursor', () => {
    const cursor = { updated_at: T1, id: 'm' }
    expect(isAfterCursor({ updated_at: T1, id: 'n' }, cursor)).toBe(true)
    expect(isAfterCursor({ updated_at: T2, id: 'a' }, cursor)).toBe(true)
    expect(isAfterCursor({ updated_at: T1, id: 'm' }, cursor)).toBe(false)
    expect(isAfterCursor({ updated_at: T1, id: 'a' }, cursor)).toBe(false)
  })
})
