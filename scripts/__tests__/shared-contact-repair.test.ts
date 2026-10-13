import { describe, it, expect } from 'vitest'
import {
  detailsFromAirtable,
  detailsFromAudit,
  findMudRecord,
  findReusableResidentContact,
  fixStaffEmail,
  isStaffDomainEmail,
  pickAuditSnapshot,
  planMudRepair,
  planResidentialRepair,
  selectSharedContacts,
  SHARED_WMRC_CONTACT_ID,
  splitName,
  storePhone,
  type AirtableContactRow,
  type AuditSnapshot,
  type ExistingContact,
  type MudListRecord,
  type MudProperty,
  type RepairBooking,
} from '../lib/shared-contact-repair'

const OFFICE = 'office@wmrc.example.gov.au'

function booking(o: Partial<RepairBooking> = {}): RepairBooking {
  return {
    id: 'b1',
    ref: 'VIC-1',
    clientSlug: 'vergevalet',
    type: 'Residential',
    createdVia: 'legacy',
    createdAt: '2026-09-01T00:00:10.000Z',
    contactId: SHARED_WMRC_CONTACT_ID,
    propertyId: 'p1',
    isMudProperty: false,
    ...o,
  }
}

function at(o: Partial<AirtableContactRow> = {}): AirtableContactRow {
  return { base: 'appMAIN', recordId: 'rec1', ref: 'VIC-1', name: 'Ann Lee', email: OFFICE, phone: '0412 345 678', ...o }
}

function snap(o: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return {
    id: 'a1',
    recordId: SHARED_WMRC_CONTACT_ID,
    createdAt: '2026-09-01T00:00:09.500Z',
    newData: { first_name: 'Bob', last_name: 'Ng', email: OFFICE, mobile_e164: '+61400000001' },
    ...o,
  }
}

const shared = new Set([SHARED_WMRC_CONTACT_ID])

function plan(
  bookings: RepairBooking[],
  opts: { audit?: AuditSnapshot[]; airtable?: AirtableContactRow[]; existing?: ExistingContact[]; currentEmails?: Array<[string, string]> } = {},
) {
  const airtableByRef = new Map<string, AirtableContactRow[]>()
  for (const r of opts.airtable ?? []) airtableByRef.set(r.ref, [...(airtableByRef.get(r.ref) ?? []), r])
  const existingByEmail = new Map<string, ExistingContact[]>()
  for (const c of opts.existing ?? []) existingByEmail.set(c.email, [...(existingByEmail.get(c.email) ?? []), c])
  const currentEmailById = new Map<string, string | null>([[SHARED_WMRC_CONTACT_ID, 'info@magixstrata.com.au'], ...(opts.currentEmails ?? [])])
  return planResidentialRepair({ bookings, audit: opts.audit ?? [], airtableByRef, existingByEmail, shared, currentEmailById })
}

describe('isStaffDomainEmail', () => {
  it('matches operator and council domains on the domain only', () => {
    expect(isStaffDomainEmail('a@dmwaste.com.au')).toBe(true)
    expect(isStaffDomainEmail('a@dmwastemanagement.com.au')).toBe(true)
    expect(isStaffDomainEmail('a@dmwaste.com')).toBe(true)
    expect(isStaffDomainEmail('Bookings@Verco.au')).toBe(true)
    expect(isStaffDomainEmail('vv@wmrc.wa.gov.au')).toBe(true)
  })

  it('ignores residents, including a staff word in the local part', () => {
    expect(isStaffDomainEmail('dmwaste.fan@gmail.com')).toBe(false)
    expect(isStaffDomainEmail('me@verco.com')).toBe(false)
    expect(isStaffDomainEmail(null)).toBe(false)
  })
})

describe('selectSharedContacts', () => {
  const b = (contactId: string, propertyId: string, o: Partial<RepairBooking> = {}) => ({ contactId, propertyId, type: 'Residential', isMudProperty: false, ...o })

  it('always includes the WMRC office row', () => {
    expect(selectSharedContacts([], [])).toEqual(new Set([SHARED_WMRC_CONTACT_ID]))
  })

  it('adds a staff-domain contact booked at 2+ distinct non-MUD properties', () => {
    const out = selectSharedContacts([{ id: 's', email: 'x@verco.au' }], [b('s', 'p1'), b('s', 'p2')])
    expect(out.has('s')).toBe(true)
  })

  it('leaves a staff member at one address, and ignores Illegal Dumping + MUD properties in the count', () => {
    const out = selectSharedContacts(
      [{ id: 's', email: 'x@dmwaste.com.au' }],
      [b('s', 'p1'), b('s', 'p1'), b('s', 'p2', { type: 'Illegal Dumping' }), b('s', 'p3', { isMudProperty: true })],
    )
    expect(out.has('s')).toBe(false)
  })

  it('never adds a resident-domain contact, however many properties', () => {
    const out = selectSharedContacts([{ id: 'r', email: 'agent@realty.com.au' }], [b('r', 'p1'), b('r', 'p2'), b('r', 'p3')])
    expect(out.has('r')).toBe(false)
  })
})

describe('splitName / storePhone', () => {
  it('splits the first word from the rest', () => {
    expect(splitName('  Jane  van Dyke ')).toEqual({ first: 'Jane', last: 'van Dyke' })
  })

  it('rejects single words and blanks', () => {
    expect(splitName('Jane')).toBeNull()
    expect(splitName('   ')).toBeNull()
    expect(splitName(null)).toBeNull()
  })

  it('stores mobiles as E.164, other numbers formatting-stripped, blanks as null', () => {
    expect(storePhone('0412 345 678')).toBe('+61412345678')
    expect(storePhone('(08) 9411 1111')).toBe('0894111111')
    expect(storePhone('  ')).toBeNull()
  })
})

describe('detailsFromAirtable / detailsFromAudit', () => {
  it('builds details from an Airtable row, lowercasing the email', () => {
    expect(detailsFromAirtable({ name: 'Ann Lee', email: ' Office@WMRC.example.gov.au ', phone: '0412345678' })).toEqual({
      ok: true,
      details: { firstName: 'Ann', lastName: 'Lee', email: OFFICE, mobile: '+61412345678' },
    })
  })

  it('reports a single-word or blank name and a blank email', () => {
    expect(detailsFromAirtable({ name: 'Ann', email: OFFICE, phone: '' })).toEqual({ ok: false, reason: 'Airtable Contact_Name is a single word' })
    expect(detailsFromAirtable({ name: '', email: OFFICE, phone: '' })).toEqual({ ok: false, reason: 'Airtable Contact_Name is blank' })
    expect(detailsFromAirtable({ name: 'Ann Lee', email: ' ', phone: '' })).toEqual({ ok: false, reason: 'Airtable Contact_Email is blank' })
  })

  it('reads the snapshot written at booking time', () => {
    expect(detailsFromAudit(snap().newData)).toEqual({ ok: true, details: { firstName: 'Bob', lastName: 'Ng', email: OFFICE, mobile: '+61400000001' } })
    expect(detailsFromAudit({ first_name: 'Bob', last_name: '', email: OFFICE }).ok).toBe(false)
    expect(detailsFromAudit({ first_name: 'Bob', last_name: 'Ng', email: '' }).ok).toBe(false)
    expect(detailsFromAudit(null).ok).toBe(false)
  })
})

describe('pickAuditSnapshot', () => {
  const b = booking({ createdVia: 'admin', createdAt: '2026-09-01T00:00:10.000Z' })

  it('takes the latest row on the booking contact within −3s…+1s', () => {
    const rows = [snap({ id: 'early', createdAt: '2026-09-01T00:00:07.500Z' }), snap({ id: 'late', createdAt: '2026-09-01T00:00:10.900Z' })]
    expect(pickAuditSnapshot(b, rows)?.id).toBe('late')
  })

  it('ignores rows outside the window or on another contact', () => {
    expect(pickAuditSnapshot(b, [snap({ createdAt: '2026-09-01T00:00:06.900Z' })])).toBeNull()
    expect(pickAuditSnapshot(b, [snap({ createdAt: '2026-09-01T00:00:11.100Z' })])).toBeNull()
    expect(pickAuditSnapshot(b, [snap({ recordId: 'other' })])).toBeNull()
  })
})

describe('fixStaffEmail', () => {
  const row = (email: string | null, id = 'staffrow') => ({ id, email })

  it('maps each mistyped D&M domain, keeping the local part', () => {
    expect(fixStaffEmail('ops@dmwaste.com', null)).toEqual({ email: 'ops@dmwaste.com.au', fix: { from: 'dmwaste.com', to: 'dmwaste.com.au', via: 'domain map' } })
    expect(fixStaffEmail('ops@dmwastemanagement.com', null).email).toBe('ops@dmwastemanagement.com.au')
    expect(fixStaffEmail('bookings@verco.com', null).email).toBe('bookings@verco.au')
    expect(fixStaffEmail('bookings@verco.com.au', null).email).toBe('bookings@verco.au')
  })

  it('prefers the address the shared staff row carries now when it is on a correct D&M domain', () => {
    expect(fixStaffEmail('bookings@verco.com.au', row('team@verco.au'))).toEqual({
      email: 'team@verco.au',
      fix: { from: 'verco.com.au', to: 'verco.au', via: 'staff row' },
    })
    // A row still on a typo domain is no help — fall back to the domain map.
    expect(fixStaffEmail('ops@dmwaste.com', row('ops@dmwaste.com')).email).toBe('ops@dmwaste.com.au')
  })

  it("never uses the WMRC row's current email (Magix since 05/10), even on a D&M domain", () => {
    expect(fixStaffEmail('bookings@verco.com', row('info@magixstrata.com.au', SHARED_WMRC_CONTACT_ID)).email).toBe('bookings@verco.au')
    expect(fixStaffEmail('bookings@verco.com', row('someone@dmwaste.com.au', SHARED_WMRC_CONTACT_ID)).email).toBe('bookings@verco.au')
  })

  it('leaves correct D&M domains, council addresses and look-alike real domains untouched', () => {
    for (const e of ['a@verco.au', 'a@dmwaste.com.au', 'a@dmwastemanagement.com.au', OFFICE, 'a@myverco.com', 'a@mail.verco.com', 'a@notdmwaste.com', 'a@verco.com.au.example.org', 'a@gmail.com']) {
      expect(fixStaffEmail(e, row('team@verco.au'))).toEqual({ email: e, fix: null })
    }
  })
})

describe('planResidentialRepair', () => {
  it('gives one contact to one person with several bookings at the same property', () => {
    const p = plan([booking({ id: 'b1', ref: 'VIC-1' }), booking({ id: 'b2', ref: 'VIC-2' })], { airtable: [at({ ref: 'VIC-1' }), at({ ref: 'VIC-2', recordId: 'rec2', name: 'ann  LEE', phone: '+61412345678' })] })
    expect(p.groups).toHaveLength(1)
    expect(p.groups[0]!.bookings.map((b) => b.ref)).toEqual(['VIC-1', 'VIC-2'])
    expect(p.groups[0]!.details).toMatchObject({ firstName: 'Ann', lastName: 'Lee', email: OFFICE, mobile: '+61412345678' })
  })

  it('gives the same person at different properties different contacts', () => {
    const p = plan([booking({ id: 'b1', ref: 'VIC-1', propertyId: 'p1' }), booking({ id: 'b2', ref: 'VIC-2', propertyId: 'p2' })], {
      airtable: [at({ ref: 'VIC-1' }), at({ ref: 'VIC-2', recordId: 'rec2' })],
    })
    expect(p.groups).toHaveLength(2)
  })

  it('splits different people at one property and notes it', () => {
    const p = plan([booking({ id: 'b1', ref: 'VIC-1' }), booking({ id: 'b2', ref: 'VIC-2' })], {
      airtable: [at({ ref: 'VIC-1' }), at({ ref: 'VIC-2', recordId: 'rec2', name: 'Cal Doe' })],
    })
    expect(p.groups).toHaveLength(2)
    expect(p.notes.propertiesWithSeveralPeople).toEqual([['VIC-1', 'VIC-2']])
  })

  it('reports legacy bookings with no Airtable row, a bad name, or conflicting duplicate rows', () => {
    const p = plan(
      [booking({ id: 'b1', ref: 'VIC-1' }), booking({ id: 'b2', ref: 'VIC-2' }), booking({ id: 'b3', ref: 'VIC-3' })],
      { airtable: [at({ ref: 'VIC-2', name: 'Ann' }), at({ ref: 'VIC-3' }), at({ ref: 'VIC-3', recordId: 'rec9', name: 'Cal Doe' })] },
    )
    expect(p.groups).toHaveLength(0)
    expect(p.unsourced.map((u) => [u.ref, u.reason])).toEqual([
      ['VIC-1', 'no Airtable master row for this Booking_Ref'],
      ['VIC-2', 'Airtable Contact_Name is a single word'],
      ['VIC-3', '2 Airtable rows for this Booking_Ref with different contacts'],
    ])
  })

  it('uses identical duplicate Airtable rows and notes the ref', () => {
    const p = plan([booking()], { airtable: [at(), at({ base: 'appVIC', recordId: 'rec2' })] })
    expect(p.groups).toHaveLength(1)
    expect(p.notes.duplicateAirtableRefs).toEqual(['VIC-1'])
  })

  it('sources Verco-created bookings from the booking-time snapshot, never Airtable', () => {
    const p = plan([booking({ createdVia: 'admin', ref: 'VIC-QX' })], { audit: [snap()], airtable: [at({ ref: 'VIC-QX' })] })
    expect(p.groups[0]).toMatchObject({ source: 'audit', details: { firstName: 'Bob', lastName: 'Ng' } })
  })

  it('reports a Verco booking with no snapshot, or two bookings sharing one snapshot', () => {
    const lone = plan([booking({ createdVia: 'admin' })])
    expect(lone.unsourced[0]?.reason).toBe('no booking-time audit snapshot')
    const twins = plan([booking({ id: 'b1', ref: 'A', createdVia: 'admin' }), booking({ id: 'b2', ref: 'B', createdVia: 'admin', propertyId: 'p2' })], { audit: [snap()] })
    expect(twins.groups).toHaveLength(0)
    expect(twins.unsourced.map((u) => u.reason)).toEqual(['booking-time audit snapshot shared with another booking', 'booking-time audit snapshot shared with another booking'])
  })

  it("corrects a mistyped D&M domain to the shared staff row's current address", () => {
    const p = plan([booking({ createdVia: 'admin', contactId: 'k' })], {
      audit: [snap({ recordId: 'k', newData: { first_name: 'Bob', last_name: 'Ng', email: 'bookings@verco.com', mobile_e164: null } })],
      currentEmails: [['k', 'Team@Verco.au']],
    })
    expect(p.groups[0]!.details.email).toBe('team@verco.au')
    expect(p.groups[0]!.emailFix).toEqual({ from: 'verco.com', to: 'verco.au', via: 'staff row' })
  })

  it('maps a typo domain on the WMRC row by domain only, and leaves correct emails alone', () => {
    const p = plan([booking({ id: 'b1', ref: 'VIC-1' }), booking({ id: 'b2', ref: 'VIC-2', propertyId: 'p2' })], {
      airtable: [at({ ref: 'VIC-1', email: 'ops@dmwaste.com' }), at({ ref: 'VIC-2', recordId: 'rec2' })],
    })
    const byRef = new Map(p.groups.map((g) => [g.bookings[0]!.ref, g]))
    expect(byRef.get('VIC-1')!.details.email).toBe('ops@dmwaste.com.au')
    expect(byRef.get('VIC-1')!.emailFix?.via).toBe('domain map')
    expect(byRef.get('VIC-2')!.details.email).toBe(OFFICE)
    expect(byRef.get('VIC-2')!.emailFix).toBeNull()
  })

  it('reuses an existing contact that is already this person at this property', () => {
    const existing: ExistingContact = { id: 'mine', email: OFFICE, firstName: 'ann', lastName: 'Lee', mobile: '+61412345678', propertyIds: ['p1'], isStrataContact: false }
    expect(plan([booking()], { airtable: [at()], existing: [existing] }).groups[0]!.reuseContactId).toBe('mine')
  })
})

describe('findReusableResidentContact', () => {
  const d = { firstName: 'Ann', lastName: 'Lee', email: OFFICE, mobile: '+61412345678' }
  const c = (o: Partial<ExistingContact>): ExistingContact => ({ id: 'c', email: OFFICE, firstName: 'Ann', lastName: 'Lee', mobile: '+61412345678', propertyIds: ['p1'], isStrataContact: false, ...o })

  it('rejects shared rows, rows used elsewhere, strata contacts, unused rows and other people', () => {
    expect(findReusableResidentContact(d, 'p1', [c({ id: SHARED_WMRC_CONTACT_ID })], shared)).toBeNull()
    expect(findReusableResidentContact(d, 'p1', [c({ propertyIds: ['p1', 'p2'] })], shared)).toBeNull()
    expect(findReusableResidentContact(d, 'p1', [c({ isStrataContact: true })], shared)).toBeNull()
    expect(findReusableResidentContact(d, 'p1', [c({ propertyIds: [] })], shared)).toBeNull()
    expect(findReusableResidentContact(d, 'p1', [c({ mobile: '+61400000000' })], shared)).toBeNull()
    expect(findReusableResidentContact(d, null, [c({})], shared)).toBeNull()
    expect(findReusableResidentContact(d, 'p1', [c({})], shared)).toBe('c')
  })
})

describe('MUD repair', () => {
  const prop = (o: Partial<MudProperty> = {}): MudProperty => ({
    id: 'mp1',
    mudCode: 'SOP-MUD-65',
    areaCode: 'SOP',
    airtableBase: 'appMAIN',
    strataContactId: 'strata1',
    externalSource: 'airtable-mud',
    externalId: 'recM1',
    ...o,
  })
  const rec = (o: Partial<MudListRecord> = {}): MudListRecord => ({ base: 'appMAIN', id: 'recM1', mudRef: 'SOP-MUD-65', contactName: 'Pat Strata', contactNumber: '0412000000', email: 'pat@strata.example.com', ...o })

  it('finds the MUD List record by record id, else by unique MUD Ref, within the council base', () => {
    expect(findMudRecord(prop(), [rec()])).toMatchObject({ ok: true })
    expect(findMudRecord(prop({ externalSource: 'csv', externalId: null }), [rec({ id: 'other' })])).toMatchObject({ ok: true })
    expect(findMudRecord(prop({ externalSource: 'csv', externalId: null }), [rec(), rec({ id: 'r2' })])).toMatchObject({ ok: false })
    expect(findMudRecord(prop(), [rec({ base: 'appVIC' })])).toEqual({ ok: false, reason: 'not in the Airtable MUD List' })
  })

  function mudPlan(o: { contactEmail?: string; records?: MudListRecord[]; strataLinked?: MudProperty[]; existing?: ExistingContact[] } = {}) {
    const p = prop()
    const existingByEmail = new Map<string, ExistingContact[]>()
    for (const c of o.existing ?? []) existingByEmail.set(c.email, [...(existingByEmail.get(c.email) ?? []), c])
    return planMudRepair({
      mudBookings: [booking({ id: 'mb1', ref: 'SOP-MUD-65-2144', type: 'MUD', propertyId: p.id, isMudProperty: true })],
      propertiesById: new Map([[p.id, p]]),
      strataLinkedToShared: o.strataLinked ?? [],
      contactEmailById: new Map([['strata1', o.contactEmail ?? 'PAT@strata.example.com']]),
      mudRecords: o.records ?? [rec()],
      existingByEmail,
      shared,
    })
  }

  it('repoints a MUD booking to its strata contact when the MUD List confirms the email', () => {
    expect(mudPlan().bookingRepoints).toEqual([{ id: 'mb1', ref: 'SOP-MUD-65-2144', oldContactId: SHARED_WMRC_CONTACT_ID, newContactId: 'strata1' }])
  })

  it('leaves the MUD booking when the MUD List disagrees', () => {
    const p = mudPlan({ contactEmail: 'someone@else.com' })
    expect(p.bookingRepoints).toHaveLength(0)
    expect(p.unsourced[0]).toMatchObject({ kind: 'booking', ref: 'SOP-MUD-65-2144' })
  })

  it('plans one strata contact per strata person across MUDs, and reports unusable rows', () => {
    const p = mudPlan({
      strataLinked: [
        prop({ id: 'a', mudCode: 'SOP-MUD-64', externalId: 'recA', strataContactId: SHARED_WMRC_CONTACT_ID }),
        prop({ id: 'b', mudCode: 'SOP-MUD-66', externalId: 'recB', strataContactId: SHARED_WMRC_CONTACT_ID }),
        prop({ id: 'c', mudCode: 'SOP-MUD-67', externalId: 'recC', strataContactId: SHARED_WMRC_CONTACT_ID }),
      ],
      records: [rec(), rec({ id: 'recA', mudRef: 'SOP-MUD-64' }), rec({ id: 'recB', mudRef: 'SOP-MUD-66' }), rec({ id: 'recC', mudRef: 'SOP-MUD-67', contactName: 'Pat' })],
    })
    expect(p.strataGroups).toHaveLength(1)
    expect(p.strataGroups[0]!.links.map((l) => l.mudCode)).toEqual(['SOP-MUD-64', 'SOP-MUD-66'])
    expect(p.strataGroups[0]!.reuseContactId).toBeNull()
    expect(p.unsourced).toEqual([{ kind: 'strata link', ref: 'SOP-MUD-67', reason: 'MUD List Contact Name is a single word' }])
  })

  it('reuses an identical contact for a strata link only when no resident booking uses it', () => {
    const linked = [prop({ id: 'a', mudCode: 'SOP-MUD-64', externalId: 'recA', strataContactId: SHARED_WMRC_CONTACT_ID })]
    const records = [rec(), rec({ id: 'recA', mudRef: 'SOP-MUD-64' })]
    const same = { id: 'x', email: 'pat@strata.example.com', firstName: 'Pat', lastName: 'Strata', mobile: '+61412000000', isStrataContact: true }
    expect(mudPlan({ strataLinked: linked, records, existing: [{ ...same, propertyIds: [] }] }).strataGroups[0]!.reuseContactId).toBe('x')
    expect(mudPlan({ strataLinked: linked, records, existing: [{ ...same, propertyIds: ['p9'] }] }).strataGroups[0]!.reuseContactId).toBeNull()
  })
})
