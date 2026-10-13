import { describe, it, expect } from 'vitest'
import {
  RESIDENT_BOOKING_HORIZON_DAYS,
  isWithinResidentHorizon,
  residentHorizonEnd,
} from '@/lib/booking/booking-horizon'

// Residents keep the 16-week window the 16-week calendar always gave them,
// even once the calendar itself runs 12 months ahead for MUD bookings.
describe('resident booking horizon', () => {
  it('is 16 weeks', () => {
    expect(RESIDENT_BOOKING_HORIZON_DAYS).toBe(112)
  })

  it('ends (exclusive) 112 days after today, across month and year boundaries', () => {
    expect(residentHorizonEnd('2026-10-13')).toBe('2027-02-02')
    expect(residentHorizonEnd('2027-03-20')).toBe('2027-07-10')
  })

  it('admits today through the last day before the end', () => {
    expect(isWithinResidentHorizon('2026-10-13', '2026-10-13')).toBe(true)
    expect(isWithinResidentHorizon('2027-02-01', '2026-10-13')).toBe(true)
  })

  it('refuses the end date and anything later (a year-ahead MUD-calendar date)', () => {
    expect(isWithinResidentHorizon('2027-02-02', '2026-10-13')).toBe(false)
    expect(isWithinResidentHorizon('2027-10-07', '2026-10-13')).toBe(false)
  })
})
