import { describe, expect, it } from 'vitest'
import {
  dayOfWeek,
  enumerateDates,
  planDates,
  windowFromToday,
  type ScheduleEntry,
} from '@/lib/scheduling/collection-dates'

describe('collection-dates: enumerateDates', () => {
  it('returns inclusive-start, exclusive-end ISO dates', () => {
    const dates = enumerateDates(
      new Date('2026-05-13T00:00:00Z'),
      new Date('2026-05-16T00:00:00Z'),
    )
    expect(dates).toEqual(['2026-05-13', '2026-05-14', '2026-05-15'])
  })

  it('handles month boundaries', () => {
    const dates = enumerateDates(
      new Date('2026-05-30T00:00:00Z'),
      new Date('2026-06-02T00:00:00Z'),
    )
    expect(dates).toEqual(['2026-05-30', '2026-05-31', '2026-06-01'])
  })

  it('handles year boundaries', () => {
    const dates = enumerateDates(
      new Date('2026-12-30T00:00:00Z'),
      new Date('2027-01-02T00:00:00Z'),
    )
    expect(dates).toEqual(['2026-12-30', '2026-12-31', '2027-01-01'])
  })

  it('handles leap-year Feb 29', () => {
    const dates = enumerateDates(
      new Date('2028-02-28T00:00:00Z'),
      new Date('2028-03-02T00:00:00Z'),
    )
    expect(dates).toEqual(['2028-02-28', '2028-02-29', '2028-03-01'])
  })

  it('returns empty array when end <= start', () => {
    const dates = enumerateDates(
      new Date('2026-05-13T00:00:00Z'),
      new Date('2026-05-13T00:00:00Z'),
    )
    expect(dates).toEqual([])
  })
})

describe('collection-dates: dayOfWeek', () => {
  it('matches Postgres EXTRACT(DOW): 0=Sun..6=Sat', () => {
    expect(dayOfWeek('2026-05-13')).toBe(3) // Wed
    expect(dayOfWeek('2026-05-17')).toBe(0) // Sun
    expect(dayOfWeek('2026-05-18')).toBe(1) // Mon
    expect(dayOfWeek('2026-05-23')).toBe(6) // Sat
  })
})

describe('collection-dates: windowFromToday', () => {
  it('returns start = today UTC midnight, end = start + weeks*7 days', () => {
    const today = new Date('2026-05-13T07:30:00Z')
    const { start, end } = windowFromToday(today, 4)
    expect(start.toISOString()).toBe('2026-05-13T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-06-10T00:00:00.000Z')
  })

  it('handles 16 weeks ahead (default horizon)', () => {
    const today = new Date('2026-05-13T00:00:00Z')
    const { end } = windowFromToday(today, 16)
    // 16 * 7 = 112 days. May 13 + 112 = Sep 2.
    expect(end.toISOString()).toBe('2026-09-02T00:00:00.000Z')
  })
})

describe('collection-dates: planDates', () => {
  const schedule: ScheduleEntry[] = [
    { id: 'area-mos', day_of_week: 1, bulk_capacity_limit: 0, anc_capacity_limit: 0, id_capacity_limit: 0 },
    { id: 'area-mos', day_of_week: 3, bulk_capacity_limit: 0, anc_capacity_limit: 0, id_capacity_limit: 0 },
    { id: 'area-sub', day_of_week: 5, bulk_capacity_limit: 60, anc_capacity_limit: 0, id_capacity_limit: 0 },
  ]

  it('produces one row per (entry, matching weekday) in the window', () => {
    const start = new Date('2026-05-18T00:00:00Z') // Monday
    const end = new Date('2026-05-25T00:00:00Z')   // Following Monday (excl.)
    const result = planDates(schedule, start, end, new Map())

    // Mon 18 May: MOS schedule for day_of_week=1 → 1 row
    // Wed 20 May: MOS schedule for day_of_week=3 → 1 row
    // Fri 22 May: SUB schedule for day_of_week=5 → 1 row
    expect(result).toHaveLength(3)
    expect(result.map((r) => r.date).sort()).toEqual(['2026-05-18', '2026-05-20', '2026-05-22'])
  })

  it('still emits a planned date on a holiday but tags is_holiday=true', () => {
    const start = new Date('2026-06-01T00:00:00Z') // WA Day, a Monday
    const end = new Date('2026-06-02T00:00:00Z')
    const holidays = new Map([['2026-06-01', 'WA Day']])
    const result = planDates(schedule, start, end, holidays)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      entity_id: 'area-mos',
      date: '2026-06-01',
      is_holiday: true,
      holiday_name: 'WA Day',
    })
  })

  it('passes through capacity limits unchanged', () => {
    const start = new Date('2026-05-22T00:00:00Z') // Friday
    const end = new Date('2026-05-23T00:00:00Z')
    const result = planDates(schedule, start, end, new Map())

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      entity_id: 'area-sub',
      bulk_capacity_limit: 60,
      anc_capacity_limit: 0,
      id_capacity_limit: 0,
    })
  })

  it('skips weekdays that have no schedule entry', () => {
    const start = new Date('2026-05-19T00:00:00Z') // Tuesday — no schedule entry for any area
    const end = new Date('2026-05-20T00:00:00Z')
    const result = planDates(schedule, start, end, new Map())

    expect(result).toEqual([])
  })

  it('groups multiple entries on the same day correctly', () => {
    // Two areas both collecting Monday
    const sched: ScheduleEntry[] = [
      { id: 'area-a', day_of_week: 1, bulk_capacity_limit: 60, anc_capacity_limit: 0, id_capacity_limit: 0 },
      { id: 'area-b', day_of_week: 1, bulk_capacity_limit: 60, anc_capacity_limit: 0, id_capacity_limit: 0 },
    ]
    const start = new Date('2026-05-18T00:00:00Z') // Mon
    const end = new Date('2026-05-19T00:00:00Z')
    const result = planDates(sched, start, end, new Map())

    expect(result).toHaveLength(2)
    expect(result.map((r) => r.entity_id).sort()).toEqual(['area-a', 'area-b'])
  })
})

describe('collection-dates: KWN schedule extends dates past Dec 2026', () => {
  // Mirrors migration 20260703085526_seed_kwn_collection_schedule.sql — the
  // four City of Kwinana zones, one per weekday Mon-Thu, unpooled, 70/60/10.
  // KWN's hand-made collection_date rows currently stop at 2026-12-17; without
  // a collection_schedule the generator would never roll KWN forward past that.
  const KWN_SCHEDULE: ScheduleEntry[] = [
    { id: 'KWN-1', day_of_week: 1, bulk_capacity_limit: 70, anc_capacity_limit: 60, id_capacity_limit: 10 }, // Mon
    { id: 'KWN-2', day_of_week: 2, bulk_capacity_limit: 70, anc_capacity_limit: 60, id_capacity_limit: 10 }, // Tue
    { id: 'KWN-3', day_of_week: 3, bulk_capacity_limit: 70, anc_capacity_limit: 60, id_capacity_limit: 10 }, // Wed
    { id: 'KWN-4', day_of_week: 4, bulk_capacity_limit: 70, anc_capacity_limit: 60, id_capacity_limit: 10 }, // Thu
  ]
  const LAST_HANDMADE_KWN_DATE = '2026-12-17'

  it('generates dates beyond the last hand-made KWN date when the 16wk window reaches it', () => {
    // Simulate the cron on a day whose 16-week horizon crosses mid-Dec 2026.
    const { start, end } = windowFromToday(new Date('2026-12-01T19:00:00Z'), 16)
    const result = planDates(KWN_SCHEDULE, start, end, new Map())

    const pastRunout = result.filter((r) => r.date > LAST_HANDMADE_KWN_DATE)
    expect(pastRunout.length).toBeGreaterThan(0)
    // All four zones keep generating past the run-out.
    expect(new Set(pastRunout.map((r) => r.entity_id))).toEqual(
      new Set(['KWN-1', 'KWN-2', 'KWN-3', 'KWN-4']),
    )
    // Extension reaches into 2027.
    expect(result.some((r) => r.date >= '2027-01-01')).toBe(true)
  })

  it('keeps each zone on its assigned weekday with capacity passed through', () => {
    const { start, end } = windowFromToday(new Date('2026-12-01T19:00:00Z'), 16)
    const result = planDates(KWN_SCHEDULE, start, end, new Map())

    for (const row of result) {
      // planDates must only emit a date on the entry's own weekday.
      expect(dayOfWeek(row.date)).toBe(row.day_of_week)
      expect(row).toMatchObject({
        bulk_capacity_limit: 70,
        anc_capacity_limit: 60,
        id_capacity_limit: 10,
      })
    }
    // KWN-1 collects Mondays only.
    const kwn1Dows = new Set(result.filter((r) => r.entity_id === 'KWN-1').map((r) => dayOfWeek(r.date)))
    expect([...kwn1Dows]).toEqual([1])
  })
})
