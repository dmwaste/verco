import { describe, it, expect } from 'vitest'
import {
  BOOKING_STATUSES,
  canTransition,
  getValidTargets,
  type BookingStatus,
} from '@/lib/booking/state-machine'

// All valid transitions from the SQL trigger. Pending Payment → Confirmed
// is the auto-confirm path added 2026-05-18 — Stripe webhook flips paid
// bookings directly to Confirmed, skipping the legacy Submitted gate.
const VALID_PAIRS: [BookingStatus, BookingStatus][] = [
  ['Pending Payment', 'Submitted'],
  ['Pending Payment', 'Confirmed'],
  ['Pending Payment', 'Cancelled'],
  ['Submitted', 'Confirmed'],
  ['Submitted', 'Cancelled'],
  ['Confirmed', 'Scheduled'],
  ['Confirmed', 'Cancelled'],
  ['Scheduled', 'Completed'],
  ['Scheduled', 'Non-conformance'],
  ['Scheduled', 'Nothing Presented'],
  ['Scheduled', 'Cancelled'],
  ['Non-conformance', 'Rebooked'],
  ['Nothing Presented', 'Rebooked'],
]

describe('canTransition', () => {
  describe('valid transitions', () => {
    it.each(VALID_PAIRS)('%s → %s returns true', (from, to) => {
      expect(canTransition(from, to)).toBe(true)
    })
  })

  describe('terminal states have no outgoing transitions', () => {
    const terminals: BookingStatus[] = ['Completed', 'Cancelled', 'Rebooked', 'Rescheduled']
    for (const terminal of terminals) {
      it(`${terminal} → any returns false`, () => {
        for (const target of BOOKING_STATUSES) {
          expect(canTransition(terminal, target)).toBe(false)
        }
      })
    }
  })

  describe('self-transitions are invalid', () => {
    it.each(BOOKING_STATUSES)('%s → %s returns false', (status) => {
      expect(canTransition(status, status)).toBe(false)
    })
  })

  describe('backward transitions are invalid', () => {
    it.each([
      ['Confirmed', 'Submitted'],
      ['Scheduled', 'Confirmed'],
      ['Completed', 'Scheduled'],
      ['Submitted', 'Pending Payment'],
    ] satisfies [BookingStatus, BookingStatus][])('%s → %s returns false', (from, to) => {
      expect(canTransition(from, to)).toBe(false)
    })
  })

  describe('skip transitions are invalid', () => {
    it.each([
      ['Pending Payment', 'Scheduled'],
      ['Pending Payment', 'Completed'],
      ['Submitted', 'Scheduled'],
      ['Submitted', 'Completed'],
      ['Confirmed', 'Completed'],
    ] satisfies [BookingStatus, BookingStatus][])('%s → %s returns false', (from, to) => {
      expect(canTransition(from, to)).toBe(false)
    })
  })

  it('Pending Payment → Confirmed is allowed (auto-confirm path)', () => {
    expect(canTransition('Pending Payment', 'Confirmed')).toBe(true)
  })

  it('exhaustive cross-product — only valid pairs return true', () => {
    const validSet = new Set(VALID_PAIRS.map(([f, t]) => `${f}→${t}`))
    for (const from of BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        const key = `${from}→${to}`
        expect(canTransition(from, to)).toBe(validSet.has(key))
      }
    }
  })
})

describe('getValidTargets', () => {
  it('Pending Payment → [Submitted, Confirmed, Cancelled]', () => {
    expect(getValidTargets('Pending Payment')).toEqual(['Submitted', 'Confirmed', 'Cancelled'])
  })

  it('Submitted → [Confirmed, Cancelled]', () => {
    expect(getValidTargets('Submitted')).toEqual(['Confirmed', 'Cancelled'])
  })

  it('Confirmed → [Scheduled, Cancelled]', () => {
    expect(getValidTargets('Confirmed')).toEqual(['Scheduled', 'Cancelled'])
  })

  it('Scheduled → [Completed, Non-conformance, Nothing Presented, Cancelled]', () => {
    expect(getValidTargets('Scheduled')).toEqual([
      'Completed', 'Non-conformance', 'Nothing Presented', 'Cancelled',
    ])
  })

  it('Non-conformance → [Rebooked]', () => {
    expect(getValidTargets('Non-conformance')).toEqual(['Rebooked'])
  })

  it('Nothing Presented → [Rebooked]', () => {
    expect(getValidTargets('Nothing Presented')).toEqual(['Rebooked'])
  })

  it('terminal states return empty array', () => {
    expect(getValidTargets('Completed')).toEqual([])
    expect(getValidTargets('Cancelled')).toEqual([])
    expect(getValidTargets('Rebooked')).toEqual([])
    expect(getValidTargets('Rescheduled')).toEqual([])
  })
})

describe('BOOKING_STATUSES', () => {
  it('contains all 10 expected statuses', () => {
    expect(BOOKING_STATUSES).toHaveLength(10)
    expect(BOOKING_STATUSES).toContain('Pending Payment')
    expect(BOOKING_STATUSES).toContain('Submitted')
    expect(BOOKING_STATUSES).toContain('Confirmed')
    expect(BOOKING_STATUSES).toContain('Scheduled')
    expect(BOOKING_STATUSES).toContain('Completed')
    expect(BOOKING_STATUSES).toContain('Non-conformance')
    expect(BOOKING_STATUSES).toContain('Nothing Presented')
    expect(BOOKING_STATUSES).toContain('Rebooked')
    expect(BOOKING_STATUSES).toContain('Rescheduled')
    expect(BOOKING_STATUSES).toContain('Cancelled')
  })
})
