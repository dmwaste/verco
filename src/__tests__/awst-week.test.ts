import { describe, it, expect } from 'vitest'

import { awstWeekRange } from '@/lib/date/awst-week'

describe('awstWeekRange — Monday–Sunday AWST week (UTC+8, no DST)', () => {
  it('midweek: Wed 1 Jul 2026 AWST → Mon 29 Jun … Sun 5 Jul', () => {
    // 2026-07-01T02:00:00Z = 10:00 AWST, Wed 1 Jul
    expect(awstWeekRange(new Date('2026-07-01T02:00:00Z'))).toEqual({
      monday: '2026-06-29',
      sunday: '2026-07-05',
    })
  })

  it('is runtime-timezone independent — an AWST-evening instant resolves to the AWST day', () => {
    // 2026-07-05T16:30:00Z is still Sun 5 Jul in UTC, but 00:30 Mon 6 Jul in AWST.
    // A UTC-based week helper would wrongly return the prior week here.
    expect(awstWeekRange(new Date('2026-07-05T16:30:00Z'))).toEqual({
      monday: '2026-07-06',
      sunday: '2026-07-12',
    })
  })

  it('Monday is inclusive (start of the window)', () => {
    // 2026-06-29T01:00:00Z = 09:00 AWST, Mon 29 Jun
    expect(awstWeekRange(new Date('2026-06-29T01:00:00Z')).monday).toBe('2026-06-29')
  })

  it('Sunday is the last day of the window', () => {
    // 2026-07-05T03:00:00Z = 11:00 AWST, Sun 5 Jul
    expect(awstWeekRange(new Date('2026-07-05T03:00:00Z'))).toEqual({
      monday: '2026-06-29',
      sunday: '2026-07-05',
    })
  })

  it('handles month/year rollover', () => {
    // 2025-12-31T20:00:00Z = 04:00 AWST, Thu 1 Jan 2026
    expect(awstWeekRange(new Date('2025-12-31T20:00:00Z'))).toEqual({
      monday: '2025-12-29',
      sunday: '2026-01-04',
    })
  })
})
