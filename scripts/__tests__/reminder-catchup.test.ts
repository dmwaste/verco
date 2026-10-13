import { describe, it, expect } from 'vitest'
import {
  isSharedContact,
  planReminderCatchup,
  reminderDue,
  SHARED_WMRC_CONTACT_ID,
  type CatchupBooking,
} from '../lib/reminder-catchup'

const TODAY = '2026-10-13'

function booking(overrides: Partial<CatchupBooking> = {}): CatchupBooking {
  return {
    id: 'b1',
    ref: 'VIC-100',
    clientSlug: 'vergevalet',
    reminderDays: 3,
    type: 'Residential',
    contactId: 'c1',
    dates: ['2026-10-14'],
    ...overrides,
  }
}

describe('reminderDue', () => {
  it('includes a booking whose reminder day passed and collection is ahead', () => {
    expect(reminderDue([booking()], TODAY).map((b) => b.id)).toEqual(['b1'])
  })

  it('includes a booking whose reminder day is today', () => {
    expect(reminderDue([booking({ dates: ['2026-10-16'] })], TODAY)).toHaveLength(1)
  })

  it('excludes a booking whose reminder day is still ahead', () => {
    expect(reminderDue([booking({ dates: ['2026-10-17'] })], TODAY)).toHaveLength(0)
  })

  it('honours a 2-day client (KWN)', () => {
    expect(reminderDue([booking({ reminderDays: 2, dates: ['2026-10-15'] })], TODAY)).toHaveLength(1)
    expect(reminderDue([booking({ reminderDays: 2, dates: ['2026-10-16'] })], TODAY)).toHaveLength(0)
  })

  it('excludes collections today or earlier — too late to remind', () => {
    expect(reminderDue([booking({ dates: ['2026-10-13'] })], TODAY)).toHaveLength(0)
    expect(reminderDue([booking({ dates: ['2026-10-12'] })], TODAY)).toHaveLength(0)
  })

  it('keys off the earliest collection date across items', () => {
    const due = reminderDue([booking({ dates: ['2026-10-20', '2026-10-14'] })], TODAY)
    expect(due[0]?.earliest).toBe('2026-10-14')
  })

  it('skips Illegal Dumping and date-less bookings', () => {
    expect(reminderDue([booking({ type: 'Illegal Dumping' }), booking({ id: 'b2', dates: [] })], TODAY)).toHaveLength(0)
  })
})

describe('isSharedContact', () => {
  it('flags the WMRC placeholder row regardless of email', () => {
    expect(isSharedContact(SHARED_WMRC_CONTACT_ID, 'someone@example.com')).toBe(true)
  })

  it('flags operator, council and strata-manager domains', () => {
    expect(isSharedContact('c', 'office@dmwaste.com.au')).toBe(true)
    expect(isSharedContact('c', 'x@dmwastemanagement.com.au')).toBe(true)
    expect(isSharedContact('c', 'bookings@verco.au')).toBe(true)
    expect(isSharedContact('c', 'VergeValet@WMRC.org.au')).toBe(true)
    expect(isSharedContact('c', 'info@magixstrata.com.au')).toBe(true)
  })

  it('leaves residents alone', () => {
    expect(isSharedContact('c', 'resident@gmail.com')).toBe(false)
    expect(isSharedContact('c', null)).toBe(false)
  })
})

describe('planReminderCatchup', () => {
  it('drops already-reminded bookings and holds back shared contacts', () => {
    const plan = planReminderCatchup(
      [booking({ id: 'a' }), booking({ id: 'b' }), booking({ id: 'c', contactId: 'shared' })],
      TODAY,
      new Set(['b']),
      new Set(['shared']),
    )
    expect(plan.send.map((b) => b.id)).toEqual(['a'])
    expect(plan.excludedSharedContact.map((b) => b.id)).toEqual(['c'])
  })
})
