/**
 * Kwinana importers attach a booking's contact under the ADR 0027 rule (#631).
 *
 * Both used to reuse the first contact carrying the email. KWN staff booked
 * residents under D&M office emails, so every imported booking under one of those
 * landed on the same contact, and a reminder for one resident texted whoever that
 * row named. An import now reuses a contact only for the same person
 * (resolveResidentContact) and never edits one.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fakeContactsDb, type FakeRow } from '../../src/__tests__/helpers/fake-contacts-db'
import { upsertContact as csvContact, type Parsed } from '../import-kwn-bookings-csv'
import { upsertContact as missingContact, type Master } from '../create-missing-kwn-bookings'

const OFFICE = 'bookings@dmwaste.example'
const staffRow: FakeRow = { id: 'office', email: OFFICE, first_name: 'Office', last_name: 'Staff', mobile_e164: '+61499999999' }
const annRow: FakeRow = { id: 'ann', email: OFFICE, first_name: 'Ann', last_name: 'Lee', mobile_e164: '+61411111111' }

const parsed = (name: string, email: string, phone: string): Parsed => ({
  ref: 'KWN-1-TEST', address: '', areaCode: 'KWN-1', status: 'Completed', date: '2026-07-01',
  location: '', notes: '', contactName: name, contactEmail: email, contactPhone: phone, services: [],
})
const master = (name: string, email: string, phone: string | null): Master => ({
  ref: 'KWN-1-TEST', epId: null, status: 'Booked', date: '2026-07-01', wasteLocation: null,
  contactName: name, contactEmail: email, contactPhone: phone, services: [],
})

const importers = [
  ['import-kwn-bookings-csv', (db: SupabaseClient, name: string, email: string, phone: string) => csvContact(db, parsed(name, email, phone))],
  ['create-missing-kwn-bookings', (db: SupabaseClient, name: string, email: string, phone: string) => missingContact(db, master(name, email, phone))],
] as const

describe.each(importers)('%s contact', (_name, attach) => {
  it('never puts a resident on another person’s contact just because the email matches', async () => {
    const db = fakeContactsDb({ contacts: [staffRow] })
    const id = await attach(db.client as unknown as SupabaseClient, 'Ann Lee', OFFICE, '0411 111 111')
    expect(id).toBe('new-1')
    expect(db.inserts).toEqual([{ first_name: 'Ann', last_name: 'Lee', email: OFFICE, mobile_e164: '+61411111111' }])
    expect(db.updates).toEqual([])
  })

  it('reuses the same person, whatever format the phone came in', async () => {
    const db = fakeContactsDb({ contacts: [staffRow, annRow] })
    const id = await attach(db.client as unknown as SupabaseClient, 'Ann Lee', 'Bookings@DMWaste.example', '0411 111 111')
    expect(id).toBe('ann')
    expect(db.inserts).toEqual([])
    expect(db.updates).toEqual([])
  })

  it('stores a missing phone as no number, not an empty string', async () => {
    const db = fakeContactsDb({ contacts: [] })
    await attach(db.client as unknown as SupabaseClient, 'Ann Lee', OFFICE, '')
    expect(db.inserts).toEqual([{ first_name: 'Ann', last_name: 'Lee', email: OFFICE, mobile_e164: null }])
  })
})
