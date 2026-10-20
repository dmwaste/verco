import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  addOneDay,
  awstDateFromUtc,
  fetchAllConfirmedBookings,
  filterBookingsReadyToSchedule,
  rateLimitRetryAfterMs,
  remindedOnBothChannels,
  reminderRunStatus,
  runWithinBudget,
  type BookingWithItemDates,
} from '@/lib/booking/schedule-transition'

describe('awstDateFromUtc', () => {
  it('converts 07:25 UTC to the same AWST calendar date (15:25 AWST)', () => {
    expect(awstDateFromUtc(new Date('2026-04-15T07:25:00Z'))).toBe('2026-04-15')
  })

  it('rolls the date forward when UTC is late evening (16:01 UTC = 00:01 AWST next day)', () => {
    expect(awstDateFromUtc(new Date('2026-04-15T16:01:00Z'))).toBe('2026-04-16')
  })

  it('stays on the same AWST date for 15:59 UTC (23:59 AWST)', () => {
    expect(awstDateFromUtc(new Date('2026-04-15T15:59:00Z'))).toBe('2026-04-15')
  })

  it('uses a fixed +8h offset (no DST) across years', () => {
    expect(awstDateFromUtc(new Date('2026-07-01T00:00:00Z'))).toBe('2026-07-01')
    expect(awstDateFromUtc(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01')
  })

  it('handles UTC just before midnight rolling to next AWST day', () => {
    expect(awstDateFromUtc(new Date('2026-04-15T23:00:00Z'))).toBe('2026-04-16')
  })
})

describe('addOneDay', () => {
  it('increments by one day in the same month', () => {
    expect(addOneDay('2026-04-15')).toBe('2026-04-16')
  })

  it('rolls over month boundaries', () => {
    expect(addOneDay('2026-04-30')).toBe('2026-05-01')
  })

  it('rolls over year boundaries', () => {
    expect(addOneDay('2026-12-31')).toBe('2027-01-01')
  })

  it('handles leap day 2028-02-28 → 2028-02-29', () => {
    expect(addOneDay('2028-02-28')).toBe('2028-02-29')
  })

  it('handles leap day 2028-02-29 → 2028-03-01', () => {
    expect(addOneDay('2028-02-29')).toBe('2028-03-01')
  })

  it('handles non-leap Feb 2026-02-28 → 2026-03-01', () => {
    expect(addOneDay('2026-02-28')).toBe('2026-03-01')
  })
})

describe('filterBookingsReadyToSchedule', () => {
  const tomorrow = '2026-04-16'

  it('returns a booking whose single item is for tomorrow', () => {
    const bookings: BookingWithItemDates[] = [
      {
        id: 'b1',
        booking_item: [{ collection_date: { date: '2026-04-16' } }],
      },
    ]
    expect(filterBookingsReadyToSchedule(bookings, tomorrow)).toEqual(['b1'])
  })

  it('excludes bookings where earliest date is not tomorrow (future)', () => {
    const bookings: BookingWithItemDates[] = [
      {
        id: 'b1',
        booking_item: [{ collection_date: { date: '2026-04-17' } }],
      },
    ]
    expect(filterBookingsReadyToSchedule(bookings, tomorrow)).toEqual([])
  })

  it('includes straggler bookings whose earliest date is already past (catch-up)', () => {
    // <= semantics: a booking confirmed after its date's 15:25 tick (e.g. an
    // NCN/NP rebook created that evening, already Confirmed) transitions on
    // the next tick rather than sitting Confirmed forever.
    const bookings: BookingWithItemDates[] = [
      {
        id: 'b1',
        booking_item: [{ collection_date: { date: '2026-04-14' } }],
      },
    ]
    expect(filterBookingsReadyToSchedule(bookings, tomorrow)).toEqual(['b1'])
  })

  it('uses the MIN of multiple item dates', () => {
    const bookings: BookingWithItemDates[] = [
      {
        id: 'b1',
        booking_item: [
          { collection_date: { date: '2026-04-16' } },
          { collection_date: { date: '2026-05-01' } },
        ],
      },
    ]
    expect(filterBookingsReadyToSchedule(bookings, tomorrow)).toEqual(['b1'])
  })

  it('includes a booking whose earliest item date is today (straggler catch-up)', () => {
    const bookings: BookingWithItemDates[] = [
      {
        id: 'b1',
        booking_item: [
          { collection_date: { date: '2026-04-15' } },
          { collection_date: { date: '2026-04-16' } },
        ],
      },
    ]
    expect(filterBookingsReadyToSchedule(bookings, tomorrow)).toEqual(['b1'])
  })

  it('excludes bookings with no items', () => {
    const bookings: BookingWithItemDates[] = [{ id: 'b1', booking_item: [] }]
    expect(filterBookingsReadyToSchedule(bookings, tomorrow)).toEqual([])
  })

  it('excludes items with null collection_date', () => {
    const bookings: BookingWithItemDates[] = [
      { id: 'b1', booking_item: [{ collection_date: null }] },
    ]
    expect(filterBookingsReadyToSchedule(bookings, tomorrow)).toEqual([])
  })

  it('returns empty array for empty input', () => {
    expect(filterBookingsReadyToSchedule([], tomorrow)).toEqual([])
  })

  it('returns multiple qualifying bookings preserving order', () => {
    const bookings: BookingWithItemDates[] = [
      { id: 'b1', booking_item: [{ collection_date: { date: '2026-04-16' } }] },
      { id: 'b2', booking_item: [{ collection_date: { date: '2026-04-17' } }] },
      { id: 'b3', booking_item: [{ collection_date: { date: '2026-04-16' } }] },
    ]
    expect(filterBookingsReadyToSchedule(bookings, tomorrow)).toEqual(['b1', 'b3'])
  })
})

describe('fetchAllConfirmedBookings', () => {
  /**
   * Builds a fake page fetcher over a fixed row set that emulates PostgREST:
   * it honours the requested range BUT never returns more than `maxRows` rows
   * in one response (Supabase's db-max-rows, 1000 on this project).
   *
   * This is the exact shape that broke KWN-2-B2IX82 / KWN-2-XZSK8X: an
   * unpaginated fetch of 1,172 Confirmed bookings silently returned 1,000,
   * so 172 bookings were invisible to the cron and never left Confirmed.
   */
  function fakeFetcher(rows: BookingWithItemDates[], maxRows = 1000) {
    const calls: Array<[number, number]> = []
    const fetchPage = async (from: number, to: number) => {
      calls.push([from, to])
      const capped = Math.min(to, from + maxRows - 1)
      return { rows: rows.slice(from, capped + 1) }
    }
    return { fetchPage, calls }
  }

  function makeRows(n: number, date = '2026-04-16'): BookingWithItemDates[] {
    return Array.from({ length: n }, (_, i) => ({
      // zero-padded so lexical id order is stable and predictable
      id: `b${String(i).padStart(5, '0')}`,
      booking_item: [{ collection_date: { date } }],
    }))
  }

  it('returns every row when the set exceeds the 1000-row API cap', async () => {
    const rows = makeRows(1172)
    const { fetchPage } = fakeFetcher(rows)

    const result = await fetchAllConfirmedBookings(fetchPage)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(1172)
    expect(result.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id))
  })

  it('requests pages no larger than the API cap', async () => {
    const { fetchPage, calls } = fakeFetcher(makeRows(1172))

    await fetchAllConfirmedBookings(fetchPage)

    for (const [from, to] of calls) {
      expect(to - from + 1).toBeLessThanOrEqual(1000)
    }
  })

  it('stops after a single page when the set fits in one page', async () => {
    const { fetchPage, calls } = fakeFetcher(makeRows(10))

    const result = await fetchAllConfirmedBookings(fetchPage)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(10)
    expect(calls).toHaveLength(1)
  })

  it('handles an exact page-size boundary without dropping or duplicating rows', async () => {
    const rows = makeRows(1000)
    const { fetchPage } = fakeFetcher(rows)

    const result = await fetchAllConfirmedBookings(fetchPage, 500)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id))
  })

  it('returns empty rows for an empty set', async () => {
    const { fetchPage } = fakeFetcher([])

    const result = await fetchAllConfirmedBookings(fetchPage)

    expect(result).toEqual({ ok: true, rows: [] })
  })

  it('propagates a page error instead of returning a partial set', async () => {
    const fetchPage = async (from: number) =>
      from === 0 ? { rows: makeRows(500) } : { rows: [], error: 'connection reset' }

    const result = await fetchAllConfirmedBookings(fetchPage, 500)

    expect(result).toEqual({ ok: false, error: 'connection reset' })
  })

  it('feeds the full set through to the date filter', async () => {
    // End-to-end guard: the booking that sat past the cap must still be picked
    // up by filterBookingsReadyToSchedule.
    const rows = makeRows(1171)
    rows.push({
      id: 'stranded',
      booking_item: [{ collection_date: { date: '2026-04-16' } }],
    })
    const { fetchPage } = fakeFetcher(rows)

    const result = await fetchAllConfirmedBookings(fetchPage)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(filterBookingsReadyToSchedule(result.rows, '2026-04-16')).toContain('stranded')
  })
})

describe('runWithinBudget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Each reminder is one send-notification call (~1.3 s for email + SMS). The
  // edge gateway answers 504 at 150 s and the worker dies shortly after, so the
  // 09:00 run had ~110 s of useful time. 244 is the 17/10/2026 candidate count.
  const SEND_MS = 1_300
  const BUDGET_MS = 110_000
  const slowSend = () => new Promise<void>((resolve) => setTimeout(resolve, SEND_MS))

  async function runTimed(count: number, concurrency: number) {
    vi.useFakeTimers()
    const items = Array.from({ length: count }, (_, i) => i)
    const started = Date.now()
    const done = runWithinBudget(items, { concurrency, deadlineMs: started + BUDGET_MS }, slowSend)
    await vi.runAllTimersAsync()
    return { result: await done, elapsedMs: Date.now() - started }
  }

  it('reproduces the 12/10 cut-off: one-at-a-time leaves most of a 244-booking day unsent', async () => {
    const { result } = await runTimed(244, 1)
    expect(result.remaining).toBeGreaterThan(150)
  })

  it('sends a 244-booking day well inside the budget at concurrency 8', async () => {
    const { result, elapsedMs } = await runTimed(244, 8)
    expect(result).toEqual({ started: 244, remaining: 0 })
    expect(elapsedMs).toBeLessThan(BUDGET_MS / 2)
  })

  it('stops starting new items at the deadline but finishes those in flight', async () => {
    vi.useFakeTimers()
    const finished: number[] = []
    const items = Array.from({ length: 100 }, (_, i) => i)
    const done = runWithinBudget(items, { concurrency: 2, deadlineMs: Date.now() + 5_000 }, async (n) => {
      await new Promise((r) => setTimeout(r, 1_000))
      finished.push(n)
    })
    await vi.runAllTimersAsync()
    const result = await done

    // Lanes start items at t=0,1,2,3,4 s (5 rounds × 2 lanes); the deadline blocks the 6th round.
    expect(result).toEqual({ started: 10, remaining: 90 })
    expect(finished).toHaveLength(10)
  })

  it('never has more than `concurrency` items in flight and starts them in order', async () => {
    let inFlight = 0
    let peak = 0
    const order: number[] = []
    const items = Array.from({ length: 25 }, (_, i) => i)

    await runWithinBudget(items, { concurrency: 4, deadlineMs: Number.POSITIVE_INFINITY }, async (n) => {
      order.push(n)
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
    })

    expect(peak).toBe(4)
    expect(order).toEqual(items)
  })

  it('handles an empty list and more lanes than items', async () => {
    expect(await runWithinBudget([], { concurrency: 8, deadlineMs: Number.POSITIVE_INFINITY }, async () => {})).toEqual({ started: 0, remaining: 0 })
    const seen: string[] = []
    const result = await runWithinBudget(['a', 'b'], { concurrency: 8, deadlineMs: Number.POSITIVE_INFINITY }, async (x) => {
      seen.push(x)
    })
    expect(result).toEqual({ started: 2, remaining: 0 })
    expect(seen).toEqual(['a', 'b'])
  })

  // Supabase rate-limits one edge function calling another per request chain.
  // On 13/10/2026 the 09:00 run hit it after ~60 calls and the call threw
  // RateLimitError with "Retry after ~52000ms"; the old runner counted every
  // later booking as failed, so ~60 of a day's reminders went out per tick.
  function rateLimitedSend(perWindow: number, windowMs: number, completed: number[]) {
    let windowStart: number | null = null
    let used = 0
    return async (n: number) => {
      const now = Date.now()
      if (windowStart === null || now >= windowStart + windowMs) {
        windowStart = now
        used = 0
      }
      if (used >= perWindow) return { retryAfterMs: windowStart + windowMs - now }
      used++
      await slowSend()
      completed.push(n)
    }
  }

  it('pauses on a rate limit and resumes when the window reopens instead of failing the rest', async () => {
    vi.useFakeTimers()
    const completed: number[] = []
    const items = Array.from({ length: 244 }, (_, i) => i)
    const started = Date.now()
    const done = runWithinBudget(
      items,
      { concurrency: 8, deadlineMs: started + BUDGET_MS },
      rateLimitedSend(60, 60_000, completed),
    )
    await vi.runAllTimersAsync()
    const result = await done

    // Two 60-call windows fit in 110 s; the third would open at 120 s.
    expect(result).toEqual({ started: 120, remaining: 124 })
    expect(new Set(completed).size).toBe(120)
    expect(Date.now() - started).toBeLessThanOrEqual(BUDGET_MS)
  })

  it('never sleeps past the deadline when the pause outlasts the budget', async () => {
    vi.useFakeTimers()
    const started = Date.now()
    const done = runWithinBudget([1, 2, 3], { concurrency: 2, deadlineMs: started + 10_000 }, async () => ({ retryAfterMs: 60_000 }))
    await vi.runAllTimersAsync()
    expect(await done).toEqual({ started: 0, remaining: 3 })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('retries the rate-limited item itself, after the pause', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    let limited = false
    const done = runWithinBudget(['a', 'b', 'c'], { concurrency: 1, deadlineMs: Date.now() + 60_000 }, async (x) => {
      calls.push(x)
      if (x === 'b' && !limited) {
        limited = true
        return { retryAfterMs: 5_000 }
      }
    })
    await vi.runAllTimersAsync()
    expect(await done).toEqual({ started: 3, remaining: 0 })
    expect(calls).toEqual(['a', 'b', 'b', 'c'])
  })
})

describe('rateLimitRetryAfterMs', () => {
  it('reads retryAfterMs off a RateLimitError', () => {
    const err = Object.assign(new Error('Rate limit exceeded for function.'), { name: 'RateLimitError', retryAfterMs: 51_986 })
    expect(rateLimitRetryAfterMs(err)).toBe(51_986)
  })

  it('falls back to the "Retry after Nms" text the runtime logs', () => {
    const err = Object.assign(new Error('Rate limit exceeded for function. Retry after 54585ms.'), { name: 'RateLimitError' })
    expect(rateLimitRetryAfterMs(err)).toBe(54_585)
  })

  it('defaults to a full minute when the wait is unreadable', () => {
    const err = Object.assign(new Error('Rate limit exceeded'), { name: 'RateLimitError' })
    expect(rateLimitRetryAfterMs(err)).toBe(60_000)
  })

  it('returns null for anything that is not a rate limit', () => {
    expect(rateLimitRetryAfterMs(new Error('timeout'))).toBeNull()
    expect(rateLimitRetryAfterMs(new TypeError('fetch failed'))).toBeNull()
    expect(rateLimitRetryAfterMs('Retry after 100ms')).toBeNull()
    expect(rateLimitRetryAfterMs(null)).toBeNull()
  })
})

describe('remindedOnBothChannels', () => {
  it('only counts a booking done when email AND sms were sent', () => {
    const done = remindedOnBothChannels([
      { booking_id: 'both', channel: 'email' },
      { booking_id: 'both', channel: 'sms' },
      { booking_id: 'email-only', channel: 'email' },
      { booking_id: 'sms-only', channel: 'sms' },
      { booking_id: null, channel: 'email' },
    ])
    expect([...done]).toEqual(['both'])
  })
})

describe('reminderRunStatus', () => {
  // Cron ticks: 01:00/01:10/01:20/01:30 UTC = 09:00–09:30 AWST.
  const at0900 = new Date('2026-10-19T01:00:00Z')
  const at0910 = new Date('2026-10-19T01:10:00Z')
  const at0930 = new Date('2026-10-19T01:30:00Z')

  it('returns 200 for a clean run on any tick', () => {
    expect(reminderRunStatus({ failed: 0, remaining: 0 }, at0900)).toBe(200)
    expect(reminderRunStatus({ failed: 0, remaining: 0 }, at0930)).toBe(200)
  })

  it('returns 207 when the budget ran out before the last tick (19/10 09:00: remaining 68)', () => {
    expect(reminderRunStatus({ failed: 0, remaining: 68 }, at0900)).toBe(207)
  })

  it('returns 207 when a send failed before the last tick (19/10 09:10: failed 1)', () => {
    expect(reminderRunStatus({ failed: 1, remaining: 0 }, at0910)).toBe(207)
  })

  it('returns 500 when the last tick leaves reminders unsent', () => {
    expect(reminderRunStatus({ failed: 0, remaining: 3 }, at0930)).toBe(500)
  })

  it('returns 500 when a send fails on the last tick', () => {
    expect(reminderRunStatus({ failed: 1, remaining: 0 }, at0930)).toBe(500)
  })

  it('treats a late-firing 09:30 tick as the last tick', () => {
    expect(reminderRunStatus({ failed: 1, remaining: 0 }, new Date('2026-10-19T01:30:04Z'))).toBe(500)
  })

  it('returns 500 for a manual run after the ticks (no tick left today)', () => {
    // 14:00 AWST
    expect(reminderRunStatus({ failed: 0, remaining: 5 }, new Date('2026-10-19T06:00:00Z'))).toBe(500)
  })

  it('judges the tick on the AWST clock, not UTC (01:00 AWST still has the 09:00 ticks ahead)', () => {
    // 17:00 UTC on 18/10 = 01:00 AWST on 19/10
    expect(reminderRunStatus({ failed: 0, remaining: 5 }, new Date('2026-10-18T17:00:00Z'))).toBe(207)
  })
})
