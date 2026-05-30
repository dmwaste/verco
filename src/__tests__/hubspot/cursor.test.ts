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
