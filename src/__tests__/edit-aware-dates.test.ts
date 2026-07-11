import { describe, it, expect } from 'vitest'
import { buildCalendarDates, mergeHeldDate } from '@/lib/booking/edit-aware-dates'
import { STATUS_LABEL, STATUS_CHIP } from '@/lib/booking/calendar'
import type { CollectionDateCapacity, CollectionDatePoolCapacity } from '@/lib/capacity/effective-capacity'

function row(
  id: string,
  date: string,
  opts: Partial<CollectionDateCapacity> = {},
): CollectionDateCapacity & { id: string } {
  return {
    id,
    date,
    bulk_capacity_limit: 100,
    bulk_units_booked: 0,
    bulk_is_closed: false,
    anc_capacity_limit: 100,
    anc_units_booked: 0,
    anc_is_closed: false,
    id_capacity_limit: 100,
    id_units_booked: 0,
    id_is_closed: false,
    ...opts,
  }
}

const BULK = new Set(['bulk'])

describe('buildCalendarDates — new-booking behaviour (no held date)', () => {
  it('filters out a capacity-full date for the needed bucket', () => {
    const result = buildCalendarDates({
      dates: [row('a', '2026-07-10', { bulk_is_closed: true })],
      poolId: null,
      poolByDate: new Map(),
      neededBuckets: BULK,
      heldDateId: null,
    })
    expect(result).toEqual([])
  })

  it('derives available/low/closed from remaining bulk capacity', () => {
    const result = buildCalendarDates({
      dates: [
        row('a', '2026-07-10', { bulk_units_booked: 0 }), // 100 left → available
        row('b', '2026-07-11', { bulk_units_booked: 95 }), // 5 left → low
      ],
      poolId: null,
      poolByDate: new Map(),
      neededBuckets: BULK,
      heldDateId: null,
    })
    expect(result.map((d) => d.status)).toEqual(['available', 'low'])
  })
})

describe('buildCalendarDates — edit mode (held date)', () => {
  it('keeps the held date even when it is capacity-full, and marks it "current"', () => {
    const result = buildCalendarDates({
      dates: [
        row('held', '2026-07-10', {
          bulk_is_closed: true,
          bulk_units_booked: 100,
        }),
      ],
      poolId: null,
      poolByDate: new Map(),
      neededBuckets: BULK,
      heldDateId: 'held',
    })
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('held')
    expect(result[0]!.status).toBe('current')
  })

  it('still filters out non-held capacity-full dates', () => {
    const result = buildCalendarDates({
      dates: [
        row('held', '2026-07-10'), // open, held
        row('full', '2026-07-11', { bulk_is_closed: true }), // closed, not held
        row('open', '2026-07-12'), // open, not held
      ],
      poolId: null,
      poolByDate: new Map(),
      neededBuckets: BULK,
      heldDateId: 'held',
    })
    expect(result.map((d) => d.id)).toEqual(['held', 'open'])
    expect(result.find((d) => d.id === 'held')!.status).toBe('current')
    expect(result.find((d) => d.id === 'open')!.status).toBe('available')
  })

  it('marks an OPEN held date "current", not "available"', () => {
    const result = buildCalendarDates({
      dates: [row('held', '2026-07-10')],
      poolId: null,
      poolByDate: new Map(),
      neededBuckets: BULK,
      heldDateId: 'held',
    })
    expect(result[0]!.status).toBe('current')
  })

  it('marks a pooled held date "current" even though pool counters are 0 (would derive closed)', () => {
    const poolRow: CollectionDatePoolCapacity = {
      date: '2026-07-10',
      bulk_capacity_limit: 0,
      bulk_units_booked: 0,
      bulk_is_closed: true,
      anc_capacity_limit: 0,
      anc_units_booked: 0,
      anc_is_closed: true,
      id_capacity_limit: 0,
      id_units_booked: 0,
      id_is_closed: true,
    }
    const result = buildCalendarDates({
      dates: [row('held', '2026-07-10')], // collection_date counters 0 by design for pooled
      poolId: 'pool-1',
      poolByDate: new Map([['2026-07-10', poolRow]]),
      neededBuckets: BULK,
      heldDateId: 'held',
    })
    expect(result).toHaveLength(1)
    expect(result[0]!.status).toBe('current')
  })
})

describe('mergeHeldDate — contractor keeps a closed/past held date (#378)', () => {
  it('returns dates unchanged when there is no separately-fetched held row', () => {
    const dates = [row('a', '2026-07-12'), row('b', '2026-07-13')]
    expect(mergeHeldDate(dates, null)).toBe(dates)
    expect(mergeHeldDate(dates, undefined)).toBe(dates)
  })

  it('does not duplicate a held row already present in the fetched set', () => {
    const dates = [row('held', '2026-07-12'), row('b', '2026-07-13')]
    const result = mergeHeldDate(dates, row('held', '2026-07-12'))
    expect(result).toBe(dates)
    expect(result.map((d) => d.id)).toEqual(['held', 'b'])
  })

  it('adds a closed held row the resident filter would have dropped, sorted by date', () => {
    // The main fetch (is_open=true, date>=today) excluded the closed held date;
    // the contractor fetch supplies it and it must land in chronological order.
    const dates = [row('open1', '2026-07-12'), row('open2', '2026-07-20')]
    const heldClosed = row('held', '2026-07-15', { bulk_is_closed: true })
    const result = mergeHeldDate(dates, heldClosed)
    expect(result.map((d) => d.id)).toEqual(['open1', 'held', 'open2'])
  })

  it('adds a PAST held row before the future dates', () => {
    const dates = [row('open1', '2026-07-12'), row('open2', '2026-07-20')]
    const heldPast = row('held', '2026-07-01')
    const result = mergeHeldDate(dates, heldPast)
    expect(result.map((d) => d.id)).toEqual(['held', 'open1', 'open2'])
  })

  it('feeds buildCalendarDates so a closed/past held date pins as "current"', () => {
    // End-to-end for the wizard fix: merge the separately-fetched closed held
    // date, then build the calendar — it must survive as the neutral "current"
    // cell, never dropped or rendered as an error.
    const dates = [row('open', '2026-07-20')]
    const heldClosedPast = row('held', '2026-07-01', {
      bulk_is_closed: true,
      bulk_units_booked: 100,
    })
    const merged = mergeHeldDate(dates, heldClosedPast)
    const calendar = buildCalendarDates({
      dates: merged,
      poolId: null,
      poolByDate: new Map(),
      neededBuckets: BULK,
      heldDateId: 'held',
    })
    expect(calendar.map((d) => d.id)).toEqual(['held', 'open'])
    expect(calendar.find((d) => d.id === 'held')!.status).toBe('current')
  })
})

describe('calendar "current" token', () => {
  it('has a label and chip style so the held date never renders as an error', () => {
    expect(STATUS_LABEL).toHaveProperty('current')
    expect(STATUS_CHIP).toHaveProperty('current')
    // must not reuse the red closed style
    expect((STATUS_CHIP as Record<string, string>).current).not.toBe(
      (STATUS_CHIP as Record<string, string>).closed,
    )
  })
})
