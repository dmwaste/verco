// scripts/lib/shared-contact-repair.ts
//
// Pure planning for scripts/repair-shared-contacts.ts — gives every booking that
// sits on a SHARED contact row (one email, many residents) a contact of its own.
//
// Background (ADR 0027, 12/10/2026): staff took phone bookings under an office
// email (WMRC; D&M/Verco staff mailboxes on Kwinana). Contacts are found by
// email, so hundreds of residents were folded onto a handful of rows, and each
// booking/edit rewrote the row for everyone. The code fix stops new spreading;
// this repairs the history, mirroring update_booking_contact's shared branch:
// INSERT a new contact, then repoint the booking (guarded on its old contact).
//
// Sources of the real per-booking details (never guessed):
//   - legacy (migrated) bookings → the Airtable master row with Booking_Ref = ref
//   - Verco-created bookings     → the contacts audit snapshot written in the
//                                  same second the booking was created
//   - MUD bookings / strata links → the property's strata contact, confirmed
//                                  against the Airtable MUD List
// Anything without a clean source is reported as unsourced and left alone.

import { canonicaliseAuMobile, normalisePhone } from '../../src/lib/phone'
import { normaliseEmail } from '../../src/lib/email'
import { SHARED_WMRC_CONTACT_ID } from './reminder-catchup'

export { SHARED_WMRC_CONTACT_ID }

/** Operator / council office domains staff typed as a resident's email (brief's rule, matched on the domain). */
const STAFF_DOMAIN = /(dmwaste|dmwastemanagement|verco\.au|wmrc)/

export function emailDomain(email: string | null | undefined): string {
  const e = (email ?? '').trim().toLowerCase()
  const at = e.lastIndexOf('@')
  return at === -1 ? '' : e.slice(at + 1)
}

export function isStaffDomainEmail(email: string | null | undefined): boolean {
  const d = emailDomain(email)
  return d !== '' && STAFF_DOMAIN.test(d)
}

// ─── Inputs ────────────────────────────────────────────────────────────────────

export interface RepairBooking {
  id: string
  ref: string
  clientSlug: string
  type: string // 'Residential' | 'MUD' | 'Illegal Dumping'
  createdVia: string // 'legacy' | 'admin' | 'resident' | …
  createdAt: string // ISO timestamp
  contactId: string
  propertyId: string | null
  isMudProperty: boolean
}

export interface ContactDetails {
  firstName: string
  lastName: string
  email: string
  mobile: string | null
}

export interface AuditSnapshot {
  id: string
  recordId: string
  createdAt: string
  newData: Record<string, unknown> | null
}

export interface AirtableContactRow {
  base: string
  recordId: string
  ref: string
  name: string
  email: string
  phone: string
}

export type Sourced = { ok: true; details: ContactDetails } | { ok: false; reason: string }

// ─── Which contacts are shared ────────────────────────────────────────────────

/**
 * The shared rows to repair: the WMRC office row always, plus any contact on an
 * operator/council domain whose non-Illegal-Dumping bookings span 2+ distinct
 * non-MUD properties (one staff mailbox booking several residents). A staff
 * member's own single-address booking is left alone.
 */
export function selectSharedContacts(
  contacts: Array<{ id: string; email: string | null }>,
  bookings: Array<Pick<RepairBooking, 'contactId' | 'type' | 'propertyId' | 'isMudProperty'>>,
): Set<string> {
  const props = new Map<string, Set<string>>()
  for (const b of bookings) {
    if (b.type === 'Illegal Dumping' || b.isMudProperty || !b.propertyId) continue
    const s = props.get(b.contactId) ?? new Set<string>()
    s.add(b.propertyId)
    props.set(b.contactId, s)
  }
  const out = new Set<string>([SHARED_WMRC_CONTACT_ID])
  for (const c of contacts) {
    if (isStaffDomainEmail(c.email) && (props.get(c.id)?.size ?? 0) >= 2) out.add(c.id)
  }
  return out
}

// ─── Turning a source into contact details ────────────────────────────────────

/** "Jane van Dyke" → { first: 'Jane', last: 'van Dyke' }; null when fewer than 2 words. */
export function splitName(full: string | null | undefined): { first: string; last: string } | null {
  const words = (full ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  return { first: words[0]!, last: words.slice(1).join(' ') }
}

/** Store rule (src/lib/phone.ts): AU mobiles → E.164, anything else formatting-stripped; blank → null. */
export function storePhone(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim()
  if (!t) return null
  return canonicaliseAuMobile(t) ?? normalisePhone(t)
}

export function detailsFromAirtable(row: Pick<AirtableContactRow, 'name' | 'email' | 'phone'>): Sourced {
  const name = splitName(row.name)
  if (!name) return { ok: false, reason: `Airtable Contact_Name is ${(row.name ?? '').trim() ? 'a single word' : 'blank'}` }
  const email = normaliseEmail(row.email ?? '')
  if (!email) return { ok: false, reason: 'Airtable Contact_Email is blank' }
  return { ok: true, details: { firstName: name.first, lastName: name.last, email, mobile: storePhone(row.phone) } }
}

export function detailsFromAudit(newData: Record<string, unknown> | null): Sourced {
  const str = (k: string) => (typeof newData?.[k] === 'string' ? (newData[k] as string).trim() : '')
  const firstName = str('first_name')
  const lastName = str('last_name')
  if (!firstName || !lastName) return { ok: false, reason: 'audit snapshot has a blank first or last name' }
  const email = normaliseEmail(str('email'))
  if (!email) return { ok: false, reason: 'audit snapshot has a blank email' }
  return { ok: true, details: { firstName, lastName, email, mobile: storePhone(str('mobile_e164')) } }
}

// ─── Mistyped D&M staff mailboxes (Dan, 13/10) ────────────────────────────────

/** The real D&M staff domains, and the typos staff entered for them (exact domain match only). */
const DM_STAFF_DOMAINS = new Set(['verco.au', 'dmwaste.com.au', 'dmwastemanagement.com.au'])
const DM_TYPO_DOMAINS: Record<string, string> = {
  'dmwaste.com': 'dmwaste.com.au',
  'dmwastemanagement.com': 'dmwastemanagement.com.au',
  'verco.com': 'verco.au', // a third party's mail domain
  'verco.com.au': 'verco.au',
}

/** Domains only — what the report may print. */
export interface EmailFix {
  from: string
  to: string
  via: 'staff row' | 'domain map'
}

/**
 * A planned email on a mistyped D&M domain → the right D&M address. When the
 * booking's shared staff row now carries a correct D&M address (staff fixed the
 * row later), that address is used; otherwise the domain is swapped and the local
 * part kept. The WMRC row is never a source — it has carried Magix's email since
 * 05/10. Every other email, correct D&M ones included, comes back unchanged.
 */
export function fixStaffEmail(email: string, currentRow: { id: string; email: string | null } | null): { email: string; fix: EmailFix | null } {
  const from = emailDomain(email)
  const mapped = DM_TYPO_DOMAINS[from]
  if (!mapped) return { email, fix: null }
  const rowEmail = normaliseEmail(currentRow?.email ?? '')
  if (currentRow && currentRow.id !== SHARED_WMRC_CONTACT_ID && DM_STAFF_DOMAINS.has(emailDomain(rowEmail))) {
    return { email: rowEmail, fix: { from, to: emailDomain(rowEmail), via: 'staff row' } }
  }
  return { email: `${email.slice(0, email.lastIndexOf('@'))}@${mapped}`, fix: { from, to: mapped, via: 'domain map' } }
}

/**
 * The contacts audit row written while this booking was created (create-booking
 * inserts or rewrites the contact a moment before inserting the booking): the
 * latest row on the booking's contact in [created_at − 3s, created_at + 1s].
 */
export function pickAuditSnapshot(b: Pick<RepairBooking, 'contactId' | 'createdAt'>, rows: AuditSnapshot[]): AuditSnapshot | null {
  const t = Date.parse(b.createdAt)
  let best: AuditSnapshot | null = null
  for (const r of rows) {
    if (r.recordId !== b.contactId) continue
    const at = Date.parse(r.createdAt)
    if (at < t - 3000 || at > t + 1000) continue
    if (!best || at > Date.parse(best.createdAt)) best = r
  }
  return best
}

// ─── Reusing an existing contact ──────────────────────────────────────────────

export interface ExistingContact {
  id: string
  email: string
  firstName: string
  lastName: string
  mobile: string | null
  /** Properties of this contact's resident bookings (not MUD, not Illegal Dumping). */
  propertyIds: string[]
  isStrataContact: boolean
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

export function samePerson(a: Pick<ContactDetails, 'firstName' | 'lastName' | 'mobile'>, b: Pick<ContactDetails, 'firstName' | 'lastName' | 'mobile'>): boolean {
  return norm(a.firstName) === norm(b.firstName) && norm(a.lastName) === norm(b.lastName) && norm(a.mobile) === norm(b.mobile)
}

/**
 * An existing contact that already IS this person at this address (e.g. a row the
 * 13/10 D1 repair created): same email, name and mobile, used only at this one
 * property, not a strata contact and not itself a shared row. Reusing it keeps one
 * person at one address on one row.
 */
export function findReusableResidentContact(
  details: ContactDetails,
  propertyId: string | null,
  candidates: ExistingContact[],
  shared: Set<string>,
): string | null {
  if (!propertyId) return null
  const hit = candidates.find(
    (c) =>
      !shared.has(c.id) &&
      !c.isStrataContact &&
      normaliseEmail(c.email) === details.email &&
      samePerson(c, details) &&
      c.propertyIds.length > 0 &&
      c.propertyIds.every((p) => p === propertyId),
  )
  return hit?.id ?? null
}

// ─── Residential plan ─────────────────────────────────────────────────────────

export type SourceKind = 'audit' | 'airtable'

export interface PlannedBooking {
  id: string
  ref: string
  oldContactId: string
  source: SourceKind
  createdAt: string
}

export interface ContactGroup {
  key: string
  clientSlug: string
  propertyId: string | null
  details: ContactDetails
  /** Source of `details` (the group's most recently created booking). */
  source: SourceKind
  /** An existing contact to repoint to instead of inserting a new one. */
  reuseContactId: string | null
  /** Set when `details.email` was moved off a mistyped D&M domain. */
  emailFix: EmailFix | null
  bookings: PlannedBooking[]
}

export interface Unsourced {
  ref: string
  clientSlug: string
  contactId: string
  reason: string
}

export interface ResidentialPlan {
  groups: ContactGroup[]
  unsourced: Unsourced[]
  notes: {
    /** Airtable rows matching a ref more than once (identical details → used). */
    duplicateAirtableRefs: string[]
    /** Refs of groups whose bookings' sources gave different emails (the latest booking's email is used). */
    emailConflicts: string[][]
    /** Refs per property that gets more than one contact (different people booked the same address). */
    propertiesWithSeveralPeople: string[][]
  }
}

function groupKey(propertyId: string | null, bookingId: string, d: ContactDetails): string {
  // Different properties always get different contacts; a booking with no property stands alone.
  return `${propertyId ?? `booking:${bookingId}`}|${norm(`${d.firstName} ${d.lastName}`)}|${norm(d.mobile)}`
}

function sameAirtableDetails(rows: AirtableContactRow[]): boolean {
  const k = (r: AirtableContactRow) => `${norm(r.name)}|${normaliseEmail(r.email ?? '')}|${storePhone(r.phone) ?? ''}`
  return rows.every((r) => k(r) === k(rows[0]!))
}

/**
 * Plan one contact per (property, person) for every residential booking on a
 * shared row. `bookings` must already exclude Illegal Dumping and MUD bookings;
 * `currentEmailById` holds each shared row's email as it stands now.
 */
export function planResidentialRepair(input: {
  bookings: RepairBooking[]
  audit: AuditSnapshot[]
  airtableByRef: Map<string, AirtableContactRow[]>
  existingByEmail: Map<string, ExistingContact[]>
  shared: Set<string>
  currentEmailById: Map<string, string | null>
}): ResidentialPlan {
  const { bookings, audit, airtableByRef, existingByEmail, shared, currentEmailById } = input
  const unsourced: Unsourced[] = []
  const duplicateAirtableRefs: string[] = []
  const sourced: Array<{ b: RepairBooking; details: ContactDetails; source: SourceKind; emailFix: EmailFix | null }> = []
  const add = (b: RepairBooking, details: ContactDetails, source: SourceKind) => {
    const fixed = fixStaffEmail(details.email, { id: b.contactId, email: currentEmailById.get(b.contactId) ?? null })
    sourced.push({ b, details: { ...details, email: fixed.email }, source, emailFix: fixed.fix })
  }

  // One audit snapshot can only describe one booking — two bookings in the same
  // window on the same row can't be told apart.
  const snapshotFor = new Map<string, AuditSnapshot>()
  const snapshotUse = new Map<string, number>()
  for (const b of bookings) {
    if (b.createdVia === 'legacy') continue
    const s = pickAuditSnapshot(b, audit)
    if (!s) continue
    snapshotFor.set(b.id, s)
    snapshotUse.set(s.id, (snapshotUse.get(s.id) ?? 0) + 1)
  }

  for (const b of bookings) {
    const fail = (reason: string) => unsourced.push({ ref: b.ref, clientSlug: b.clientSlug, contactId: b.contactId, reason })
    if (b.createdVia === 'legacy') {
      const rows = airtableByRef.get(b.ref) ?? []
      if (rows.length === 0) { fail('no Airtable master row for this Booking_Ref'); continue }
      if (rows.length > 1) {
        if (!sameAirtableDetails(rows)) { fail(`${rows.length} Airtable rows for this Booking_Ref with different contacts`); continue }
        duplicateAirtableRefs.push(b.ref)
      }
      const r = detailsFromAirtable(rows[0]!)
      if (!r.ok) { fail(r.reason); continue }
      add(b, r.details, 'airtable')
    } else {
      const s = snapshotFor.get(b.id)
      if (!s) { fail('no booking-time audit snapshot'); continue }
      if ((snapshotUse.get(s.id) ?? 0) > 1) { fail('booking-time audit snapshot shared with another booking'); continue }
      const r = detailsFromAudit(s.newData)
      if (!r.ok) { fail(r.reason); continue }
      add(b, r.details, 'audit')
    }
  }

  const byKey = new Map<string, Array<(typeof sourced)[number]>>()
  for (const s of sourced) {
    const k = groupKey(s.b.propertyId, s.b.id, s.details)
    byKey.set(k, [...(byKey.get(k) ?? []), s])
  }

  const emailConflicts: string[][] = []
  const groups: ContactGroup[] = []
  for (const [key, members] of byKey) {
    const latest = [...members].sort((a, b) => Date.parse(b.b.createdAt) - Date.parse(a.b.createdAt))[0]!
    if (new Set(members.map((m) => m.details.email)).size > 1) emailConflicts.push(members.map((m) => m.b.ref).sort())
    const propertyId = latest.b.propertyId
    groups.push({
      key,
      clientSlug: latest.b.clientSlug,
      propertyId,
      details: latest.details,
      source: latest.source,
      reuseContactId: findReusableResidentContact(latest.details, propertyId, existingByEmail.get(latest.details.email) ?? [], shared),
      emailFix: latest.emailFix,
      bookings: members
        .map((m) => ({ id: m.b.id, ref: m.b.ref, oldContactId: m.b.contactId, source: m.source, createdAt: m.b.createdAt }))
        .sort((a, b) => a.ref.localeCompare(b.ref)),
    })
  }
  groups.sort((a, b) => a.key.localeCompare(b.key))

  const perProperty = new Map<string, ContactGroup[]>()
  for (const g of groups) if (g.propertyId) perProperty.set(g.propertyId, [...(perProperty.get(g.propertyId) ?? []), g])

  return {
    groups,
    unsourced: unsourced.sort((a, b) => a.ref.localeCompare(b.ref)),
    notes: {
      duplicateAirtableRefs: duplicateAirtableRefs.sort(),
      emailConflicts,
      propertiesWithSeveralPeople: [...perProperty.values()]
        .filter((gs) => gs.length > 1)
        .map((gs) => gs.flatMap((g) => g.bookings.map((b) => b.ref)).sort()),
    },
  }
}

// ─── MUD plan ─────────────────────────────────────────────────────────────────

export interface MudProperty {
  id: string
  mudCode: string | null
  areaCode: string
  /** The Airtable base whose MUD List holds this council (SUB/VIC have their own). */
  airtableBase: string
  strataContactId: string | null
  externalSource: string | null
  externalId: string | null
}

export interface MudListRecord {
  base: string
  id: string
  mudRef: string | null
  contactName: string | null
  contactNumber: string | null
  email: string | null
}

/**
 * The MUD List record for a property, from its council's base only (SUB/VIC were
 * cloned from the main base, so the same MUD Ref can sit in two bases): by Airtable
 * record id when it came from there, else by a unique MUD Ref.
 */
export function findMudRecord(p: MudProperty, all: MudListRecord[]): { ok: true; record: MudListRecord } | { ok: false; reason: string } {
  const records = all.filter((r) => r.base === p.airtableBase)
  if (p.externalSource === 'airtable-mud' && p.externalId) {
    const hit = records.filter((r) => r.id === p.externalId)
    if (hit.length === 1) return { ok: true, record: hit[0]! }
  }
  const code = norm(p.mudCode)
  if (!code) return { ok: false, reason: 'property has no MUD code' }
  const hits = records.filter((r) => norm(r.mudRef) === code)
  if (hits.length === 0) return { ok: false, reason: 'not in the Airtable MUD List' }
  if (hits.length > 1) return { ok: false, reason: `${hits.length} Airtable MUD List rows share this MUD Ref` }
  return { ok: true, record: hits[0]! }
}

export interface MudBookingRepoint {
  id: string
  ref: string
  oldContactId: string
  newContactId: string
}

export interface StrataGroup {
  details: ContactDetails
  reuseContactId: string | null
  emailFix: EmailFix | null
  links: Array<{ propertyId: string; mudCode: string; oldContactId: string }>
}

export interface MudPlan {
  bookingRepoints: MudBookingRepoint[]
  strataGroups: StrataGroup[]
  unsourced: Array<{ kind: 'booking' | 'strata link'; ref: string; reason: string }>
}

/**
 * MUD bookings on a shared row go back to their property's strata contact (what
 * create_mud_booking_with_capacity_check attaches), but only when the Airtable
 * MUD List confirms that contact's email. Properties whose strata link IS a
 * shared row get the MUD List contact (one row per strata person, reusing an
 * identical existing contact that no resident booking uses).
 */
export function planMudRepair(input: {
  mudBookings: RepairBooking[]
  propertiesById: Map<string, MudProperty>
  strataLinkedToShared: MudProperty[]
  contactEmailById: Map<string, string>
  mudRecords: MudListRecord[]
  existingByEmail: Map<string, ExistingContact[]>
  shared: Set<string>
}): MudPlan {
  const { mudBookings, propertiesById, strataLinkedToShared, contactEmailById, mudRecords, existingByEmail, shared } = input
  const plan: MudPlan = { bookingRepoints: [], strataGroups: [], unsourced: [] }

  for (const b of mudBookings) {
    const fail = (reason: string) => plan.unsourced.push({ kind: 'booking', ref: b.ref, reason })
    const p = b.propertyId ? propertiesById.get(b.propertyId) : undefined
    if (!p) { fail('MUD booking has no property'); continue }
    if (!p.strataContactId) { fail(`${p.mudCode ?? 'MUD'} has no strata contact`); continue }
    if (shared.has(p.strataContactId)) { fail(`${p.mudCode ?? 'MUD'} strata contact is itself a shared row`); continue }
    const rec = findMudRecord(p, mudRecords)
    if (!rec.ok) { fail(`${p.mudCode ?? 'MUD'}: ${rec.reason}`); continue }
    const strataEmail = normaliseEmail(contactEmailById.get(p.strataContactId) ?? '')
    if (!strataEmail || normaliseEmail(rec.record.email ?? '') !== strataEmail) {
      fail(`${p.mudCode ?? 'MUD'}: strata contact's email differs from the Airtable MUD List`)
      continue
    }
    plan.bookingRepoints.push({ id: b.id, ref: b.ref, oldContactId: b.contactId, newContactId: p.strataContactId })
  }

  const groups = new Map<string, StrataGroup>()
  for (const p of strataLinkedToShared) {
    const label = p.mudCode ?? p.id.slice(0, 8)
    const fail = (reason: string) => plan.unsourced.push({ kind: 'strata link', ref: label, reason })
    const rec = findMudRecord(p, mudRecords)
    if (!rec.ok) { fail(rec.reason); continue }
    const r = detailsFromAirtable({ name: rec.record.contactName ?? '', email: rec.record.email ?? '', phone: rec.record.contactNumber ?? '' })
    if (!r.ok) { fail(r.reason.replace('Airtable Contact_Name', 'MUD List Contact Name').replace('Airtable Contact_Email', 'MUD List Email')); continue }
    const fixed = fixStaffEmail(r.details.email, null)
    const d = { ...r.details, email: fixed.email }
    const key = `${d.email}|${norm(`${d.firstName} ${d.lastName}`)}|${norm(d.mobile)}`
    const g = groups.get(key) ?? {
      details: d,
      emailFix: fixed.fix,
      // Reuse an identical contact only when no resident booking uses it.
      reuseContactId:
        (existingByEmail.get(d.email) ?? []).find(
          (c) => !shared.has(c.id) && normaliseEmail(c.email) === d.email && samePerson(c, d) && c.propertyIds.length === 0,
        )?.id ?? null,
      links: [],
    }
    g.links.push({ propertyId: p.id, mudCode: label, oldContactId: p.strataContactId! })
    groups.set(key, g)
  }
  plan.strataGroups = [...groups.values()]
  return plan
}
