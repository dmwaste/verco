import { describe, expect, it } from 'vitest'
import {
  buildStaleCloseoutAlert,
  DEFAULT_STALE_THRESHOLD_DAYS,
  evaluateStaleCloseouts,
  findNotDispatched,
  isBacklogReminderDay,
  staleCutoffDate,
  summariseBacklog,
  summariseCohort,
  worklistUrl,
  type LiveBookingRow,
  type StaleCloseoutInput,
  type StopRow,
} from '@/lib/ops/stale-closeouts'

const ORIGIN = 'https://admin.verco.au'

// 20/10/2026 is a Tuesday; 19/10/2026 a Monday. Threshold 3 → cohort 17/10.
const TUESDAY = '2026-10-20'
const MONDAY = '2026-10-19'

let seq = 0
function stop(over: Partial<StopRow> = {}): StopRow {
  seq += 1
  return {
    areaId: 'area-cam-b',
    areaCode: 'CAM-B',
    date: '2026-10-17',
    status: 'Pending',
    bookingId: `booking-${seq}`,
    ...over,
  }
}

function stops(n: number, over: Partial<StopRow> = {}): StopRow[] {
  return Array.from({ length: n }, () => stop(over))
}

function booking(over: Partial<LiveBookingRow> = {}): LiveBookingRow {
  return { areaCode: 'VIC', dates: ['2026-10-17'], stopStatuses: [], ...over }
}

function input(over: Partial<StaleCloseoutInput> = {}): StaleCloseoutInput {
  return {
    today: TUESDAY,
    thresholdDays: 3,
    cohortStops: [],
    openStops: [],
    liveBookings: [],
    ...over,
  }
}

describe('staleCutoffDate', () => {
  it('defaults to 3 days — two days of normal closeout lag are not stale', () => {
    expect(DEFAULT_STALE_THRESHOLD_DAYS).toBe(3)
    expect(staleCutoffDate(TUESDAY, 3)).toBe('2026-10-17')
  })

  it('crosses month and year boundaries', () => {
    expect(staleCutoffDate('2026-11-02', 3)).toBe('2026-10-30')
    expect(staleCutoffDate('2027-01-02', 3)).toBe('2026-12-30')
  })
})

describe('summariseCohort', () => {
  it('counts only stops dated exactly on the cohort date (2 and 4 days past are excluded)', () => {
    const rows = [
      ...stops(2, { date: '2026-10-17' }),
      ...stops(5, { date: '2026-10-18' }), // 2 days past — still inside normal lag
      ...stops(7, { date: '2026-10-16' }), // 4 days past — named yesterday, backlog now
    ]
    expect(summariseCohort(rows, '2026-10-17')).toEqual([
      { areaCode: 'CAM-B', dispatched: 2, closedOut: 0, open: 2 },
    ])
  })

  it('splits dispatched / closed out / open per area, ignores Cancelled, drops fully closed areas', () => {
    const rows = [
      ...stops(3, { areaId: 'a-kwn2', areaCode: 'KWN-2', status: 'Pending' }),
      ...stops(30, { areaId: 'a-kwn2', areaCode: 'KWN-2', status: 'Completed' }),
      ...stops(4, { areaId: 'a-kwn2', areaCode: 'KWN-2', status: 'Non-conformance' }),
      ...stops(3, { areaId: 'a-kwn2', areaCode: 'KWN-2', status: 'Nothing Presented' }),
      ...stops(2, { areaId: 'a-kwn2', areaCode: 'KWN-2', status: 'Cancelled' }),
      ...stops(50, { areaId: 'a-camb', areaCode: 'CAM-B', status: 'Pending' }),
      ...stops(20, { areaId: 'a-mos', areaCode: 'MOS', status: 'Completed' }),
    ]
    expect(summariseCohort(rows, '2026-10-17')).toEqual([
      { areaCode: 'CAM-B', dispatched: 50, closedOut: 0, open: 50 },
      { areaCode: 'KWN-2', dispatched: 40, closedOut: 37, open: 3 },
    ])
  })
})

describe('summariseBacklog', () => {
  it('groups Pending stops on or before the cutoff by area, with date range and distinct bookings', () => {
    const rows = [
      stop({ areaId: 'a-vin', areaCode: 'VIN', date: '2026-08-25', bookingId: 'x1' }),
      stop({ areaId: 'a-vin', areaCode: 'VIN', date: '2026-09-03', bookingId: 'x2' }),
      stop({ areaId: 'a-vin', areaCode: 'VIN', date: '2026-09-03', bookingId: 'x2' }), // 2nd stream, same booking
      stop({ areaId: 'a-vic', areaCode: 'VIC', date: '2026-08-03', bookingId: 'x3' }),
      stop({ areaId: 'a-vic', areaCode: 'VIC', date: '2026-10-18', bookingId: 'x4' }), // not stale yet
      stop({ areaId: 'a-vic', areaCode: 'VIC', date: '2026-08-04', status: 'Completed' }),
    ]
    expect(summariseBacklog(rows, '2026-10-17')).toEqual([
      { areaId: 'a-vin', areaCode: 'VIN', openStops: 3, bookings: 2, oldestDate: '2026-08-25', newestDate: '2026-09-03' },
      { areaId: 'a-vic', areaCode: 'VIC', openStops: 1, bookings: 1, oldestDate: '2026-08-03', newestDate: '2026-08-03' },
    ])
  })
})

describe('findNotDispatched', () => {
  it('keeps Scheduled bookings past the cutoff with no open stop', () => {
    const rows = [
      booking({ areaCode: 'VIC', dates: ['2026-08-03'] }), // no stops at all
      booking({ areaCode: 'KWN-1', dates: ['2026-10-17'] }),
      booking({ areaCode: 'MOS', dates: ['2026-10-17'], stopStatuses: ['Pending', 'Pending'] }), // open stops: the backlog
      booking({ areaCode: 'COT', dates: ['2026-10-18'] }), // inside normal lag
      booking({ areaCode: 'PEP', dates: ['2026-10-10', '2026-10-21'] }), // has a future date
      booking({ areaCode: 'SUB', dates: [] }), // no dated items — nothing to judge
    ]
    expect(findNotDispatched(rows, '2026-10-17')).toEqual([
      { areaCode: 'VIC', date: '2026-08-03' },
      { areaCode: 'KWN-1', date: '2026-10-17' },
    ])
  })

  it('counts a booking whose only stop is Cancelled — a date move whose stop was never revived (#486)', () => {
    const rows = [booking({ areaCode: 'KWN-2', dates: ['2026-10-14'], stopStatuses: ['Cancelled'] })]
    expect(findNotDispatched(rows, '2026-10-17')).toEqual([{ areaCode: 'KWN-2', date: '2026-10-14' }])
  })

  it('counts a booking with closed stops but no open one — a stream that was never dispatched', () => {
    const rows = [booking({ areaCode: 'VIN', dates: ['2026-10-14'], stopStatuses: ['Completed', 'Cancelled'] })]
    expect(findNotDispatched(rows, '2026-10-17')).toEqual([{ areaCode: 'VIN', date: '2026-10-14' }])
  })
})

describe('isBacklogReminderDay', () => {
  it('is Monday (AWST calendar date) only', () => {
    expect(isBacklogReminderDay(MONDAY)).toBe(true)
    expect(isBacklogReminderDay(TUESDAY)).toBe(false)
    expect(isBacklogReminderDay('2026-10-25')).toBe(false) // Sunday
  })
})

describe('evaluateStaleCloseouts', () => {
  it('alerts when the cohort date still has open stops', () => {
    const r = evaluateStaleCloseouts(input({ cohortStops: stops(4), openStops: stops(4) }))
    expect(r.cohortDate).toBe('2026-10-17')
    expect(r.trigger).toBe('newly_stale')
    expect(r.newlyStale).toEqual([{ areaCode: 'CAM-B', dispatched: 4, closedOut: 0, open: 4 }])
  })

  it('alerts when the only new problem is a booking that was not dispatched', () => {
    const r = evaluateStaleCloseouts(input({ liveBookings: [booking({ dates: ['2026-10-17'] })] }))
    expect(r.trigger).toBe('newly_stale')
    expect(r.newlyNotDispatched).toEqual([{ areaCode: 'VIC', date: '2026-10-17' }])
  })

  it('stays quiet on a weekday when only the old backlog remains — no daily repeat', () => {
    const r = evaluateStaleCloseouts(
      input({
        cohortStops: stops(10, { status: 'Completed' }),
        openStops: stops(6, { date: '2026-10-01' }),
        liveBookings: [booking({ dates: ['2026-09-01'] })],
      }),
    )
    expect(r.trigger).toBeNull()
    expect(r.backlog).toHaveLength(1)
    expect(r.notDispatched).toHaveLength(1)
  })

  it('restates the backlog on Monday even with nothing newly stale', () => {
    const r = evaluateStaleCloseouts(input({ today: MONDAY, openStops: stops(6, { date: '2026-10-01' }) }))
    expect(r.cohortDate).toBe('2026-10-16')
    expect(r.trigger).toBe('weekly_backlog')
  })

  it('stays quiet on Monday when there is no backlog', () => {
    expect(evaluateStaleCloseouts(input({ today: MONDAY })).trigger).toBeNull()
  })

  it('totals the standing backlog across areas, stops, bookings and not-dispatched', () => {
    const r = evaluateStaleCloseouts(
      input({
        openStops: [
          ...stops(3, { areaId: 'a1', areaCode: 'VIN', date: '2026-10-01' }),
          stop({ areaId: 'a2', areaCode: 'CAM-A', date: '2026-10-17', bookingId: 'same' }),
          stop({ areaId: 'a2', areaCode: 'CAM-A', date: '2026-10-17', bookingId: 'same' }),
        ],
        liveBookings: [booking({ areaCode: 'VIC', dates: ['2026-09-01'] })],
      }),
    )
    expect(r.totals).toEqual({ openStops: 5, openBookings: 4, notDispatched: 1, areas: 3 })
  })
})

describe('worklistUrl', () => {
  it('points at the admin bookings list filtered to Scheduled bookings in the date range', () => {
    expect(worklistUrl(ORIGIN, { dateFrom: '2026-10-17', dateTo: '2026-10-17' })).toBe(
      'https://admin.verco.au/admin/bookings?status=Scheduled&date_from=2026-10-17&date_to=2026-10-17',
    )
    expect(worklistUrl(ORIGIN, { dateTo: '2026-10-17' })).toBe(
      'https://admin.verco.au/admin/bookings?status=Scheduled&date_to=2026-10-17',
    )
  })
})

describe('buildStaleCloseoutAlert', () => {
  it('returns null when nothing warrants an alert', () => {
    expect(buildStaleCloseoutAlert(evaluateStaleCloseouts(input()), { adminOrigin: ORIGIN, closedOutSince: {} })).toBeNull()
  })

  it('names each newly stale area with its counts, the standing backlog, and both worklist links', () => {
    const report = evaluateStaleCloseouts(
      input({
        cohortStops: [
          ...stops(50, { areaId: 'a-camb', areaCode: 'CAM-B' }),
          ...stops(3, { areaId: 'a-kwn2', areaCode: 'KWN-2' }),
          ...stops(37, { areaId: 'a-kwn2', areaCode: 'KWN-2', status: 'Completed' }),
        ],
        openStops: [
          ...stops(50, { areaId: 'a-camb', areaCode: 'CAM-B' }),
          ...stops(3, { areaId: 'a-kwn2', areaCode: 'KWN-2' }),
          ...stops(91, { areaId: 'a-vin', areaCode: 'VIN', date: '2026-08-25' }),
        ],
        liveBookings: [booking({ areaCode: 'VIC', dates: ['2026-10-17'] })],
      }),
    )
    const alert = buildStaleCloseoutAlert(report, {
      adminOrigin: ORIGIN,
      closedOutSince: { 'a-camb': 0, 'a-kwn2': 37, 'a-vin': 119 },
    })!
    const text = [alert.title, ...alert.lines].join('\n')

    expect(alert.title).toContain('Sat 17/10/2026')
    expect(text).toContain('CAM-B: 50 of 50 stops still open, 0 closed out')
    expect(text).toContain('KWN-2: 3 of 40 stops still open, 37 closed out')
    expect(text).toContain('Not dispatched (Scheduled, no open stop): VIC 1 booking')
    expect(text).toContain('Standing backlog: 144 open stops on 144 bookings across 4 areas')
    expect(text).toContain('VIN: 91 open stops, 25/08/2026 · 119 closed out since 25/08/2026')
    expect(text).toContain('CAM-B: 50 open stops, 17/10/2026 · 0 closed out since 17/10/2026')
    expect(alert.links).toEqual([
      {
        label: 'Worklist — Sat 17/10/2026',
        url: 'https://admin.verco.au/admin/bookings?status=Scheduled&date_from=2026-10-17&date_to=2026-10-17',
      },
      { label: 'Full backlog', url: 'https://admin.verco.au/admin/bookings?status=Scheduled&date_to=2026-10-17' },
    ])
  })

  it('carries counts and area codes only — never a booking id', () => {
    const report = evaluateStaleCloseouts(
      input({ cohortStops: [stop({ bookingId: 'secret-booking-id' })], openStops: [stop({ bookingId: 'secret-booking-id' })] }),
    )
    const alert = buildStaleCloseoutAlert(report, { adminOrigin: ORIGIN, closedOutSince: {} })!
    expect(JSON.stringify(alert)).not.toContain('secret-booking-id')
  })

  it('says "unknown" rather than a false zero when a closed-out count is missing', () => {
    const report = evaluateStaleCloseouts(input({ cohortStops: stops(2), openStops: stops(2) }))
    const alert = buildStaleCloseoutAlert(report, { adminOrigin: ORIGIN, closedOutSince: {} })!
    expect(alert.lines.join('\n')).toContain('CAM-B: 2 open stops, 17/10/2026 · closed-out count unknown')
  })

  it('frames the Monday reminder as a restated backlog with only the full-backlog link', () => {
    const report = evaluateStaleCloseouts(
      input({
        today: MONDAY,
        openStops: stops(6, { areaId: 'a-vin', areaCode: 'VIN', date: '2026-09-01' }),
        liveBookings: [booking({ areaCode: 'VIC', dates: ['2026-08-03'] })],
      }),
    )
    const alert = buildStaleCloseoutAlert(report, { adminOrigin: ORIGIN, closedOutSince: { 'a-vin': 12 } })!
    const text = alert.lines.join('\n')

    expect(alert.title).toContain('weekly')
    expect(text).toContain('Nothing newly stale today')
    expect(text).toContain('VIN: 6 open stops, 01/09/2026 · 12 closed out since 01/09/2026')
    expect(text).toContain('Not dispatched (no open stop): VIC 1 booking (oldest 03/08/2026)')
    expect(alert.links).toEqual([
      { label: 'Full backlog', url: 'https://admin.verco.au/admin/bookings?status=Scheduled&date_to=2026-10-16' },
    ])
  })
})
