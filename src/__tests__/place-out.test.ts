import { describe, expect, it } from 'vitest'
import { placeOutStart, placeOutVerdict } from '@/lib/booking/place-out'

describe('placeOutStart', () => {
  it('subtracts the place-out hours from AWST midnight on the collection date', () => {
    // Collection Mon 15 Jun 2026 AWST, 48h window → from Sat 13 Jun 00:00 AWST
    const start = placeOutStart('2026-06-15', 48)
    expect(start.toISOString()).toBe(new Date('2026-06-13T00:00:00+08:00').toISOString())
  })

  it('zero hours means the window opens at AWST midnight on the day', () => {
    const start = placeOutStart('2026-06-15', 0)
    expect(start.toISOString()).toBe(new Date('2026-06-15T00:00:00+08:00').toISOString())
  })

  it('is timezone-fixed to +08:00 (WA has no DST)', () => {
    // 24h before midnight AWST = 16:00 UTC two days prior
    const start = placeOutStart('2026-01-10', 24)
    expect(start.toISOString()).toBe('2026-01-08T16:00:00.000Z')
  })
})

describe('placeOutVerdict', () => {
  const now = new Date('2026-06-13T10:00:00+08:00') // Sat 10am AWST

  it("'none' when there is no upcoming collection date", () => {
    expect(placeOutVerdict(null, 48, now)).toBe('none')
  })

  it("'open' when now is inside the window", () => {
    // Collection Mon 15th, 48h window opens Sat 13th 00:00 — now is Sat 10am
    expect(placeOutVerdict('2026-06-15', 48, now)).toBe('open')
  })

  it("'not-yet' when the pile is out before the window opens", () => {
    // Collection Wed 17th, 48h window opens Mon 15th 00:00 — now is Sat
    expect(placeOutVerdict('2026-06-17', 48, now)).toBe('not-yet')
  })

  it("'open' exactly at the window boundary", () => {
    const boundary = new Date('2026-06-13T00:00:00+08:00')
    expect(placeOutVerdict('2026-06-15', 48, boundary)).toBe('open')
  })
})
