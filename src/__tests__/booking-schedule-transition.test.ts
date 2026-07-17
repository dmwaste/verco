import { describe, it, expect } from 'vitest'
import {
  addOneDay,
  awstDateFromUtc,
  filterBookingsReadyToSchedule,
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
