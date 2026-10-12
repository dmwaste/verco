import { describe, it, expect } from 'vitest'
import { resolveContact, type ExistingContact } from '@/lib/contacts/contact-match'

const row = (
  id: string,
  first: string,
  last: string,
  mobile: string | null,
  usage: { bookedElsewhere?: boolean; isStrataContact?: boolean } = {},
): ExistingContact => ({
  id,
  first_name: first,
  last_name: last,
  mobile_e164: mobile,
  bookedElsewhere: usage.bookedElsewhere ?? false,
  isStrataContact: usage.isStrataContact ?? false,
})

const entered = { first_name: 'Ann', last_name: 'Lee', mobile_e164: '+61411111111' }

describe('resolveContact', () => {
  it('inserts when nobody has the email yet', () => {
    expect(resolveContact([], entered, false)).toEqual({ action: 'insert' })
    expect(resolveContact([], entered, true)).toEqual({ action: 'insert' })
  })

  it('reuses a row with the same name and mobile, untouched', () => {
    const rows = [row('a', 'Ann', 'Lee', '+61411111111')]
    expect(resolveContact(rows, entered, false)).toEqual({ action: 'reuse', contactId: 'a' })
  })

  it('matches names case- and whitespace-insensitively', () => {
    const rows = [row('a', ' ann ', 'LEE', '+61411111111')]
    expect(resolveContact(rows, entered, false)).toEqual({ action: 'reuse', contactId: 'a' })
  })

  it('treats a missing mobile on both sides as the same', () => {
    const rows = [row('a', 'Ann', 'Lee', null)]
    expect(resolveContact(rows, { ...entered, mobile_e164: '' }, false)).toEqual({ action: 'reuse', contactId: 'a' })
  })

  it('picks the matching row among duplicates sharing the email', () => {
    const rows = [row('a', 'Bob', 'Ray', '+61422222222'), row('b', 'Ann', 'Lee', '+61411111111')]
    expect(resolveContact(rows, entered, false)).toEqual({ action: 'reuse', contactId: 'b' })
  })

  // The 12/10/2026 WMRC incident: staff booked residents by phone under one
  // office email, and each booking rewrote that shared row's name + mobile, so
  // every other booking on it texted the newest resident.
  it('never rewrites a row that other addresses use — inserts instead', () => {
    const rows = [row('office', 'Previous', 'Resident', '+61499999999', { bookedElsewhere: true })]
    expect(resolveContact(rows, entered, false)).toEqual({ action: 'insert' })
  })

  it('never rewrites a MUD strata contact from a booking — inserts instead', () => {
    const rows = [row('strata', 'Strata', 'Manager', '+61499999999', { isStrataContact: true })]
    expect(resolveContact(rows, entered, false)).toEqual({ action: 'insert' })
  })

  it('updates a row used only at this address (same household, new name or number)', () => {
    const rows = [row('household', 'Ann', 'Lee', '+61400000000')]
    expect(resolveContact(rows, entered, false)).toEqual({ action: 'update', contactId: 'household' })
    const partner = [row('household', 'Sam', 'Lee', '+61411111111')]
    expect(resolveContact(partner, entered, false)).toEqual({ action: 'update', contactId: 'household' })
  })

  it('does not guess between two local rows sharing the email', () => {
    const rows = [row('a', 'Sam', 'Lee', '+61400000000'), row('b', 'Kim', 'Lee', '+61400000001')]
    expect(resolveContact(rows, entered, false)).toEqual({ action: 'insert' })
  })

  it('lets a signed-in resident update their own single row, wherever else they booked', () => {
    const rows = [row('me', 'Ann', 'Lee', '+61400000000', { bookedElsewhere: true })]
    expect(resolveContact(rows, entered, true)).toEqual({ action: 'update', contactId: 'me' })
  })

  it('does not guess which row to update when the resident\'s email has duplicates', () => {
    const rows = [
      row('a', 'Ann', 'Lee', '+61400000000', { bookedElsewhere: true }),
      row('b', 'Ann', 'Leigh', '+61400000001', { bookedElsewhere: true }),
    ]
    expect(resolveContact(rows, entered, true)).toEqual({ action: 'insert' })
  })
})
