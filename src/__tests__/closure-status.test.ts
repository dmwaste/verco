import { describe, expect, it } from 'vitest'
import {
  CLOSURE_REASON,
  closureReason,
  closureStatus,
  type ClosureInput,
} from '@/lib/collection-dates/closure-status'

const holidays = new Map<string, string>([
  ['2026-06-01', 'WA Day'],
  ['2026-12-25', 'Christmas Day'],
])

/** A genuinely open date — each test flips exactly the signals it exercises. */
const open: ClosureInput = {
  isOpen: true,
  lockedClosed: false,
  isPast: false,
  allBucketsClosed: false,
  date: '2026-05-20',
}

describe('closureStatus', () => {
  it("returns 'open' for an open, unlocked, future date with bucket capacity", () => {
    expect(closureStatus(open, holidays)).toBe('open')
  })

  it("returns 'open' for an open date falling ON a public holiday (regression)", () => {
    expect(closureStatus({ ...open, date: '2026-06-01' }, holidays)).toBe('open')
    expect(closureStatus({ ...open, date: '2026-12-25' }, holidays)).toBe('open')
  })

  it("locked_closed overrides is_open=true → 'closed' (BR-0018)", () => {
    expect(closureStatus({ ...open, lockedClosed: true }, holidays)).toBe('closed')
  })

  it("isPast overrides is_open=true → 'closed' (BR-0019 legacy unlocked rows)", () => {
    expect(closureStatus({ ...open, isPast: true }, holidays)).toBe('closed')
  })

  it("all buckets closed alone → 'closed' (capacity closure, pool-aware input)", () => {
    expect(closureStatus({ ...open, allBucketsClosed: true }, holidays)).toBe('closed')
  })

  it("is_open=false on a non-holiday → 'closed'", () => {
    expect(closureStatus({ ...open, isOpen: false }, holidays)).toBe('closed')
  })

  it("holiday wins for every closure reason → 'holiday'", () => {
    const onHoliday = { ...open, date: '2026-06-01' }
    expect(closureStatus({ ...onHoliday, isOpen: false }, holidays)).toBe('holiday')
    expect(closureStatus({ ...onHoliday, lockedClosed: true }, holidays)).toBe('holiday')
    expect(closureStatus({ ...onHoliday, isPast: true }, holidays)).toBe('holiday')
    expect(closureStatus({ ...onHoliday, allBucketsClosed: true }, holidays)).toBe('holiday')
  })

  it("returns 'closed' for a closed date when the holiday map is empty", () => {
    expect(closureStatus({ ...open, isOpen: false, date: '2026-06-01' }, new Map())).toBe(
      'closed',
    )
  })

  it("hostile case: all four signals true + holiday → exactly 'holiday'", () => {
    expect(
      closureStatus(
        {
          isOpen: false,
          lockedClosed: true,
          isPast: true,
          allBucketsClosed: true,
          date: '2026-12-25',
        },
        holidays,
      ),
    ).toBe('holiday')
  })
})

describe('closureReason', () => {
  it('returns null for a genuinely open date', () => {
    expect(closureReason(open)).toBeNull()
  })

  it('precedence: past > locked > manual > capacity', () => {
    const all = {
      ...open,
      isOpen: false,
      lockedClosed: true,
      isPast: true,
      allBucketsClosed: true,
    }
    expect(closureReason(all)).toBe('past')
    expect(closureReason({ ...all, isPast: false })).toBe('locked')
    expect(closureReason({ ...all, isPast: false, lockedClosed: false })).toBe('manual')
    expect(
      closureReason({ ...all, isPast: false, lockedClosed: false, isOpen: true }),
    ).toBe('capacity')
  })
})

describe('CLOSURE_REASON copy contract (VER-259 D-F4 — pinned, do not reword casually)', () => {
  it('pill labels', () => {
    expect(CLOSURE_REASON.past.pill).toBe('Past')
    expect(CLOSURE_REASON.locked.pill).toBe('T-3 lock')
    expect(CLOSURE_REASON.manual.pill).toBe('Admin closed')
    expect(CLOSURE_REASON.capacity.pill).toBe('Full')
  })

  it('tooltip titles', () => {
    expect(CLOSURE_REASON.past.title).toBe('Closed — date has passed')
    expect(CLOSURE_REASON.locked.title).toBe('Closed — bookings locked at the T-3 cutoff')
    expect(CLOSURE_REASON.manual.title).toBe('Closed — set closed by an administrator')
    expect(CLOSURE_REASON.capacity.title).toBe('Closed — all capacity exhausted')
  })
})
