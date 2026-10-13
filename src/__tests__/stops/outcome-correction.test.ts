import { describe, it, expect } from 'vitest'
import {
  canCorrectStopOutcome,
  correctionDeadline,
  correctionNotice,
  isCorrectableOutcome,
  replacesEarlierNotice,
} from '@/lib/stops/outcome-correction'

/**
 * UI mirror of the correct_stop_outcome RPC gates (ADR 0030). The RPC is the
 * enforcement; these decide whether the "Correct outcome" button shows and
 * which resident email the server action sends.
 */

const base = {
  role: 'contractor-admin',
  stopStatus: 'Completed',
  bookingStatus: 'Completed',
  collectionDate: '2026-10-13',
  todayAwst: '2026-10-13',
} as const

describe('correctionDeadline', () => {
  it('is 7 days after the collection date, inclusive', () => {
    expect(correctionDeadline('2026-10-13')).toBe('2026-10-20')
  })
  it('crosses month and year ends', () => {
    expect(correctionDeadline('2026-12-28')).toBe('2027-01-04')
  })
})

describe('canCorrectStopOutcome', () => {
  it('allows a contractor admin on a closed-out stop inside the window', () => {
    expect(canCorrectStopOutcome(base)).toBe(true)
  })

  it.each(['contractor-staff', 'client-admin', 'client-staff', 'field', 'ranger', 'resident', null])(
    'refuses role %s',
    (role) => {
      expect(canCorrectStopOutcome({ ...base, role })).toBe(false)
    },
  )

  it('allows the last day of the window and refuses the day after', () => {
    expect(canCorrectStopOutcome({ ...base, todayAwst: '2026-10-20' })).toBe(true)
    expect(canCorrectStopOutcome({ ...base, todayAwst: '2026-10-21' })).toBe(false)
  })

  it.each(['Pending', 'Cancelled'])('refuses a %s stop', (stopStatus) => {
    expect(canCorrectStopOutcome({ ...base, stopStatus })).toBe(false)
  })

  it.each(['Rebooked', 'Cancelled', 'Confirmed'])('refuses when the booking is %s', (bookingStatus) => {
    expect(canCorrectStopOutcome({ ...base, bookingStatus })).toBe(false)
  })

  it('allows a closed stop while a sibling pass keeps the booking Scheduled', () => {
    expect(canCorrectStopOutcome({ ...base, bookingStatus: 'Scheduled' })).toBe(true)
  })
})

describe('isCorrectableOutcome', () => {
  it('accepts only the three closeout outcomes', () => {
    expect(['Completed', 'Non-conformance', 'Nothing Presented'].every(isCorrectableOutcome)).toBe(true)
    expect(isCorrectableOutcome('Pending')).toBe(false)
    expect(isCorrectableOutcome('Cancelled')).toBe(false)
  })
})

describe('resident email for a correction', () => {
  it('sends the notice for the new outcome when moving to NCN or NP', () => {
    expect(correctionNotice('Non-conformance')).toBe('ncn_raised')
    expect(correctionNotice('Nothing Presented')).toBe('np_raised')
  })
  it('sends "disregard our earlier notice" when moving to Completed', () => {
    expect(correctionNotice('Completed')).toBe('closeout_corrected')
  })
  it('flags the new notice as replacing the old one only on an NCN ↔ NP swap', () => {
    expect(replacesEarlierNotice('Non-conformance', 'Nothing Presented')).toBe(true)
    expect(replacesEarlierNotice('Nothing Presented', 'Non-conformance')).toBe(true)
    expect(replacesEarlierNotice('Completed', 'Non-conformance')).toBe(false)
    expect(replacesEarlierNotice('Non-conformance', 'Completed')).toBe(false)
  })
})
