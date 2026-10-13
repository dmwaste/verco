/**
 * attachContact — the ADR 0027 contact rule (resolveContact) for the Edge
 * Functions that only have an email to go on: create-ticket and create-user (#631).
 *
 * Both used to find a contact by email and overwrite its name and mobile, so a
 * ticket or a new login under a shared email (the WMRC office address sat on 278
 * bookings) rewrote the contact on every other resident's booking — the 12/10
 * incident path. A row may now only change when the change can't reach anyone else.
 *
 * Deno-only module loaded through a runtime-only import path (tsc never follows
 * it). The Supabase client is an in-memory fake of the query shapes it issues.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { fakeContactsDb, type FakeRow } from './helpers/fake-contacts-db'

type Household = { propertyId: string } | 'one-address' | 'none'
type Entered = { first_name: string; last_name: string; email: string; mobile_e164?: string | null }
type AttachResult =
  | { ok: true; contactId: string; action: 'reuse' | 'update' | 'insert' }
  | { ok: false; error: string }
type AttachContact = (
  supabase: unknown,
  entered: Entered,
  opts: { household: Household; enteredBySelf: boolean },
) => Promise<AttachResult>

const ATTACH_MODULE = '../../supabase/functions/_shared/contact-attach.ts'

let attachContact: AttachContact

beforeAll(async () => {
  ;({ attachContact } = (await import(/* @vite-ignore */ ATTACH_MODULE)) as { attachContact: AttachContact })
})

const OFFICE = 'office@council.example'
const contact = (id: string, first: string, last: string, mobile: string | null, email = OFFICE): FakeRow => ({
  id,
  email,
  first_name: first,
  last_name: last,
  mobile_e164: mobile,
})
const booking = (contactId: string, propertyId: string | null): FakeRow => ({ contact_id: contactId, property_id: propertyId })
const ann: Entered = { first_name: 'Ann', last_name: 'Lee', email: OFFICE, mobile_e164: '+61411111111' }

// The WMRC office row: one contact, bookings at many addresses.
const officeSeed = () => ({
  contacts: [contact('office', 'Previous', 'Resident', '+61499999999')],
  booking: [booking('office', 'P1'), booking('office', 'P2'), booking('office', 'P3')],
})

describe('attachContact — create-ticket (household = the ticket booking’s address, or none)', () => {
  it('a staff ticket under an email shared across addresses gets a new contact — the shared one is never rewritten', async () => {
    const db = fakeContactsDb(officeSeed())
    const res = await attachContact(db.client, ann, { household: { propertyId: 'P1' }, enteredBySelf: false })
    expect(res).toEqual({ ok: true, contactId: 'new-1', action: 'insert' })
    expect(db.updates).toEqual([])
    expect(db.inserts).toEqual([{ first_name: 'Ann', last_name: 'Lee', email: OFFICE, mobile_e164: '+61411111111' }])
  })

  it('a ticket with no booking keeps only the same person — a different name gets its own contact', async () => {
    const db = fakeContactsDb({ contacts: [contact('one', 'Sam', 'Lee', null)], booking: [booking('one', 'P1')] })
    const res = await attachContact(db.client, { ...ann, mobile_e164: undefined }, { household: 'none', enteredBySelf: false })
    expect(res).toMatchObject({ ok: true, action: 'insert' })
    expect(db.updates).toEqual([])
  })

  it('the same person is reused untouched', async () => {
    const db = fakeContactsDb({ contacts: [contact('ann', 'Ann', 'Lee', '+61411111111')], booking: [booking('ann', 'P9')] })
    const res = await attachContact(db.client, ann, { household: 'none', enteredBySelf: false })
    expect(res).toEqual({ ok: true, contactId: 'ann', action: 'reuse' })
    expect(db.updates).toEqual([])
    expect(db.inserts).toEqual([])
  })

  it('finds pre-canonicalisation mixed-case rows (#575)', async () => {
    const db = fakeContactsDb({ contacts: [contact('ann', 'Ann', 'Lee', '+61411111111', 'Office@Council.Example')] })
    const res = await attachContact(db.client, ann, { household: 'none', enteredBySelf: false })
    expect(res).toEqual({ ok: true, contactId: 'ann', action: 'reuse' })
  })

  it('a ticket about a booking corrects a contact used only at that booking’s address (same household)', async () => {
    const db = fakeContactsDb({
      contacts: [contact('household', 'Sam', 'Lee', '+61400000000')],
      booking: [booking('household', 'P1'), booking('household', 'P1')],
    })
    const res = await attachContact(db.client, ann, { household: { propertyId: 'P1' }, enteredBySelf: false })
    expect(res).toEqual({ ok: true, contactId: 'household', action: 'update' })
    expect(db.updates).toEqual([
      { id: 'household', data: { first_name: 'Ann', last_name: 'Lee', mobile_e164: '+61411111111' } },
    ])
  })

  it('an update with no mobile entered keeps the stored number', async () => {
    const db = fakeContactsDb({ contacts: [contact('household', 'Sam', 'Lee', '+61400000000')], booking: [booking('household', 'P1')] })
    await attachContact(db.client, { ...ann, mobile_e164: undefined }, { household: { propertyId: 'P1' }, enteredBySelf: false })
    expect(db.updates).toEqual([{ id: 'household', data: { first_name: 'Ann', last_name: 'Lee' } }])
  })

  it('a booking with no property (an ID booking) counts as another address', async () => {
    const db = fakeContactsDb({
      contacts: [contact('c', 'Sam', 'Lee', '+61400000000')],
      booking: [booking('c', 'P1'), booking('c', null)],
    })
    const res = await attachContact(db.client, ann, { household: { propertyId: 'P1' }, enteredBySelf: false })
    expect(res).toMatchObject({ ok: true, action: 'insert' })
    expect(db.updates).toEqual([])
  })

  it('never rewrites a MUD strata contact', async () => {
    const db = fakeContactsDb({
      contacts: [contact('strata', 'Strata', 'Manager', '+61499999999')],
      eligible_properties: [{ strata_contact_id: 'strata' }],
    })
    const res = await attachContact(db.client, ann, { household: { propertyId: 'P1' }, enteredBySelf: false })
    expect(res).toMatchObject({ ok: true, action: 'insert' })
    expect(db.updates).toEqual([])
  })

  it('a resident’s own ticket still corrects their single contact, wherever else it is used', async () => {
    const db = fakeContactsDb(officeSeed())
    const res = await attachContact(db.client, ann, { household: 'none', enteredBySelf: true })
    expect(res).toEqual({ ok: true, contactId: 'office', action: 'update' })
  })
})

describe('attachContact — create-user (household = one address at most)', () => {
  it('a login under the shared office email gets its own contact — the many-address row is never rewritten', async () => {
    const db = fakeContactsDb(officeSeed())
    const res = await attachContact(db.client, ann, { household: 'one-address', enteredBySelf: false })
    expect(res).toMatchObject({ ok: true, action: 'insert' })
    expect(db.updates).toEqual([])
  })

  it('corrects a contact whose bookings are all at one address (a resident given a staff login)', async () => {
    const db = fakeContactsDb({
      contacts: [contact('home', 'Annie', 'Lee', '+61411111111')],
      booking: [booking('home', 'P1'), booking('home', 'P1')],
    })
    const res = await attachContact(db.client, ann, { household: 'one-address', enteredBySelf: false })
    expect(res).toEqual({ ok: true, contactId: 'home', action: 'update' })
  })

  it('corrects a contact with no bookings at all', async () => {
    const db = fakeContactsDb({ contacts: [contact('fresh', 'Annie', 'Lee', null)] })
    const res = await attachContact(db.client, ann, { household: 'one-address', enteredBySelf: false })
    expect(res).toEqual({ ok: true, contactId: 'fresh', action: 'update' })
  })

  it('a booking with no property counts as a second address', async () => {
    const db = fakeContactsDb({
      contacts: [contact('c', 'Annie', 'Lee', null)],
      booking: [booking('c', 'P1'), booking('c', null)],
    })
    const res = await attachContact(db.client, ann, { household: 'one-address', enteredBySelf: false })
    expect(res).toMatchObject({ ok: true, action: 'insert' })
  })

  it('treats every row as shared when its bookings are too many to read in full', async () => {
    const db = fakeContactsDb({
      contacts: [contact('c', 'Annie', 'Lee', null)],
      booking: Array.from({ length: 1000 }, () => booking('c', 'P1')),
    })
    const res = await attachContact(db.client, ann, { household: 'one-address', enteredBySelf: false })
    expect(res).toMatchObject({ ok: true, action: 'insert' })
    expect(db.updates).toEqual([])
  })
})

describe('attachContact — failures', () => {
  it('returns the lookup error and writes nothing', async () => {
    const db = fakeContactsDb(officeSeed(), { failContactsLookup: 'boom' })
    const res = await attachContact(db.client, ann, { household: 'none', enteredBySelf: false })
    expect(res).toEqual({ ok: false, error: 'Failed to look up contact: boom' })
    expect(db.updates).toEqual([])
    expect(db.inserts).toEqual([])
  })
})
