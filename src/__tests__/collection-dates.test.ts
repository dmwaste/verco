import { describe, expect, it } from 'vitest'
import {
  capWindowEnd,
  dayOfWeek,
  enumerateDates,
  holidayCoverageEnd,
  planDates,
  weekOfMonth,
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

// ADR 0029: the calendar runs ~12 months ahead, and MUD days in unpooled areas
// are flagged from collection_schedule.mud_weeks instead of by hand.
describe('collection-dates: MUD days from mud_weeks', () => {
  const thursdays = (mud_weeks: number[] | null): ScheduleEntry[] => [
    { id: 'VIN', day_of_week: 4, bulk_capacity_limit: 60, anc_capacity_limit: 60, id_capacity_limit: 10, mud_weeks },
  ]
  // Thursdays in January 2027: 7, 14, 21, 28.
  const jan = { start: new Date('2027-01-01T00:00:00Z'), end: new Date('2027-02-01T00:00:00Z') }

  it('numbers each weekday occurrence within its month (1st … 5th)', () => {
    expect(weekOfMonth('2027-01-04')).toBe(1)
    expect(weekOfMonth('2027-01-07')).toBe(1)
    expect(weekOfMonth('2027-01-08')).toBe(2)
    expect(weekOfMonth('2027-01-28')).toBe(4)
    expect(weekOfMonth('2027-01-29')).toBe(5)
  })

  it('flags only the listed occurrences', () => {
    const rows = planDates(thursdays([1, 3]), jan.start, jan.end, new Map())
    expect(rows.filter((r) => r.for_mud).map((r) => r.date)).toEqual(['2027-01-07', '2027-01-21'])
  })

  it('flags every occurrence for {1..5}', () => {
    const rows = planDates(thursdays([1, 2, 3, 4, 5]), jan.start, jan.end, new Map())
    expect(rows.every((r) => r.for_mud)).toBe(true)
    expect(rows).toHaveLength(4)
  })

  it('never flags when mud_weeks is NULL or absent (staff curate by hand)', () => {
    expect(planDates(thursdays(null), jan.start, jan.end, new Map()).some((r) => r.for_mud)).toBe(false)
    const legacy = [{ id: 'X', day_of_week: 4, bulk_capacity_limit: 1, anc_capacity_limit: 1, id_capacity_limit: 1 }]
    expect(planDates(legacy, jan.start, jan.end, new Map()).some((r) => r.for_mud)).toBe(false)
  })

  it('never flags a public holiday', () => {
    const rows = planDates(thursdays([1, 2, 3, 4, 5]), jan.start, jan.end, new Map([['2027-01-14', 'Test Day']]))
    expect(rows.find((r) => r.date === '2027-01-14')).toMatchObject({ is_holiday: true, for_mud: false })
  })
})

// Generating a date past the last loaded holiday list would open a public
// holiday as a collection day, so generation stops at the end of the last
// year whose list includes December (WA publishes a year at a time).
describe('collection-dates: holiday coverage cap', () => {
  it('covers through 31 December of the last year with a December holiday', () => {
    expect(holidayCoverageEnd(['2027-06-07', '2027-12-27', '2027-12-28'])).toBe('2028-01-01')
  })

  it('ignores a later year that is only partly loaded', () => {
    expect(holidayCoverageEnd(['2026-12-25', '2027-01-01', '2027-06-07'])).toBe('2027-01-01')
  })

  it('returns null when there is no complete year at all', () => {
    expect(holidayCoverageEnd(['2027-01-01'])).toBeNull()
    expect(holidayCoverageEnd([])).toBeNull()
  })

  it('caps the window end but never extends it', () => {
    const end = new Date('2027-11-09T00:00:00Z')
    expect(capWindowEnd(end, '2028-01-01').toISOString().slice(0, 10)).toBe('2027-11-09')
    expect(capWindowEnd(new Date('2028-02-01T00:00:00Z'), '2028-01-01').toISOString().slice(0, 10)).toBe('2028-01-01')
    expect(capWindowEnd(end, null).toISOString().slice(0, 10)).toBe('2027-11-09')
  })
})
