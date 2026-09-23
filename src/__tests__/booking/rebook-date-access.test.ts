import { describe, it, expect } from 'vitest'
import {
  checkRebookDate,
  isRebookDateBookable,
  bucketsFromRow,
  type RebookDateGate,
} from '@/lib/booking/rebook-date-access'
import { nextDayCutoff, isPastNextDayCutoff } from '@/lib/booking/next-day-cutoff'

/**
 * Fixed clock for every case below: Mon 28 Sep 2026, 09:00 AWST (01:00 UTC).
 * That is comfortably before the 3:00pm cut-off for a Tue 29/09 collection, so
 * the date cases stay about capacity and closure unless a case says otherwise.
 */
const NOW = new Date('2026-09-28T01:00:00Z')
const TOMORROW = '2026-09-29'

const openRow = {
  bulk_is_closed: false,
  bulk_capacity_limit: 60,
  bulk_units_booked: 10,
  anc_is_closed: false,
  anc_capacity_limit: 10,
  anc_units_booked: 0,
  id_is_closed: false,
  id_capacity_limit: 5,
  id_units_booked: 0,
}

const gate = (over: Partial<RebookDateGate> = {}): RebookDateGate => ({
  date: TOMORROW,
  is_open: true,
  locked_closed: false,
  buckets: bucketsFromRow(openRow),
  ...over,
})

/** Inside the 3-day window: the lock has closed every bucket, room remains. */
const lockedGate = gate({
  locked_closed: true,
  buckets: bucketsFromRow({
    ...openRow,
    bulk_is_closed: true,
    anc_is_closed: true,
    id_is_closed: true,
  }),
})

describe('checkRebookDate', () => {
  it('allows a normal open date', () => {
    expect(checkRebookDate(gate(), ['bulk'], NOW)).toEqual({
      bookable: true,
      reason: null,
      insideLockWindow: false,
    })
  })

  it('allows a date closed only by the T-3 lock — the WMRC ad-hoc ask', () => {
    expect(checkRebookDate(lockedGate, ['bulk'], NOW)).toEqual({
      bookable: true,
      reason: null,
      insideLockWindow: true,
    })
  })

  it('refuses a full bucket even inside the lock window', () => {
    const full = gate({
      locked_closed: true,
      buckets: bucketsFromRow({
        ...openRow,
        bulk_is_closed: true,
        bulk_units_booked: 60,
      }),
    })
    expect(checkRebookDate(full, ['bulk'], NOW)).toEqual({
      bookable: false,
      reason: 'full',
      insideLockWindow: true,
    })
  })

  it('refuses a public holiday or admin-closed date', () => {
    expect(checkRebookDate(gate({ is_open: false }), ['bulk'], NOW).bookable).toBe(false)
    // Even when the lock also applies.
    expect(
      checkRebookDate({ ...lockedGate, is_open: false }, ['bulk'], NOW).bookable,
    ).toBe(false)
  })

  it('refuses a bucket an admin closed when the lock is not the cause', () => {
    const adminClosedBucket = gate({
      buckets: bucketsFromRow({ ...openRow, bulk_is_closed: true }),
    })
    expect(checkRebookDate(adminClosedBucket, ['bulk'], NOW)).toEqual({
      bookable: false,
      reason: 'closed',
      insideLockWindow: false,
    })
  })

  it('checks every bucket the booking needs, not just the first', () => {
    const ancFull = gate({
      buckets: bucketsFromRow({ ...openRow, anc_units_booked: 10 }),
    })
    expect(checkRebookDate(ancFull, ['bulk'], NOW).bookable).toBe(true)
    expect(checkRebookDate(ancFull, ['bulk', 'anc'], NOW).bookable).toBe(false)
    expect(checkRebookDate(ancFull, ['bulk', 'anc'], NOW).reason).toBe('full')
  })

  it('refuses an unknown or unconfigured bucket rather than waving it through', () => {
    expect(checkRebookDate(gate(), ['nonsense'], NOW).bookable).toBe(false)
  })

  it('exposes a plain boolean for callers that only need yes/no', () => {
    expect(isRebookDateBookable(lockedGate, ['bulk'], NOW)).toBe(true)
    expect(isRebookDateBookable(gate({ is_open: false }), ['bulk'], NOW)).toBe(false)
  })
})

describe('bucketsFromRow', () => {
  it('maps a collection_date / collection_date_pool row onto the bucket codes', () => {
    const buckets = bucketsFromRow(openRow)
    expect(buckets.bulk).toEqual({ is_closed: false, capacity_limit: 60, units_booked: 10 })
    expect(buckets.id).toEqual({ is_closed: false, capacity_limit: 5, units_booked: 0 })
  })

  it('reads a pool member\'s inert own-row counters as zero capacity', () => {
    // A pooled area carries limit 0 on its OWN row; judging a pooled date on
    // that row must therefore refuse, which is why callers pass the pool row.
    const poolMemberOwnRow = { ...openRow, bulk_capacity_limit: 0, bulk_units_booked: 0 }
    const g = gate({ buckets: bucketsFromRow(poolMemberOwnRow) })
    expect(checkRebookDate(g, ['bulk'], NOW)).toEqual({
      bookable: false,
      reason: 'full',
      insideLockWindow: false,
    })
  })
})

describe('the 3:00pm cut-off (WMRC)', () => {
  it('is 3:00pm AWST the day before, as an exact instant', () => {
    // 3:00pm AWST = 07:00 UTC; WA has no daylight saving.
    expect(nextDayCutoff('2026-10-02').toISOString()).toBe('2026-10-01T07:00:00.000Z')
  })

  it('allows a next-day redo before 3:00pm and refuses it after', () => {
    const before = new Date('2026-09-28T06:59:00Z') // 2:59pm AWST
    const after = new Date('2026-09-28T07:01:00Z') // 3:01pm AWST
    expect(checkRebookDate(lockedGate, ['bulk'], before).bookable).toBe(true)
    expect(checkRebookDate(lockedGate, ['bulk'], after)).toEqual({
      bookable: false,
      reason: 'past-cutoff',
      insideLockWindow: true,
    })
  })

  it('refuses exactly on 3:00pm, not a minute later', () => {
    expect(isPastNextDayCutoff(TOMORROW, new Date('2026-09-28T07:00:00Z'))).toBe(true)
    expect(isPastNextDayCutoff(TOMORROW, new Date('2026-09-28T06:59:59Z'))).toBe(false)
  })

  it('does not touch a date further out — 9pm tonight is fine for Wednesday', () => {
    const wednesday = gate({ date: '2026-09-30' })
    const ninePm = new Date('2026-09-28T13:00:00Z') // 9pm AWST Monday
    expect(checkRebookDate(wednesday, ['bulk'], ninePm).bookable).toBe(true)
  })

  it('reports the cut-off before capacity — the day is over either way', () => {
    const fullAndLate = gate({
      buckets: bucketsFromRow({ ...openRow, bulk_units_booked: 60 }),
    })
    expect(checkRebookDate(fullAndLate, ['bulk'], new Date('2026-09-28T08:00:00Z')).reason)
      .toBe('past-cutoff')
  })
})
