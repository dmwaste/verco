// scripts/repair-shared-contacts.ts
/**
 * Give every booking on a SHARED contact row its own contact again (D5 of the
 * 12/10/2026 WMRC shared-contact incident, ADR 0027).
 *
 * Shared rows: the WMRC office row 8220f1bc… (~277 VV bookings), plus any contact
 * on an operator/council domain (dmwaste / dmwastemanagement / verco.au / wmrc)
 * booked at 2+ distinct non-MUD properties (D&M staff mailboxes on Kwinana, a few
 * VV). Illegal Dumping bookings keep their staff contact. Rules + sources are in
 * lib/shared-contact-repair.ts:
 *   legacy bookings  → Airtable master (VV: main/SUB/VIC bases; KWN: Bookings All)
 *   Verco bookings   → the contacts audit snapshot written at booking creation
 *   MUD              → the property's strata contact / the Airtable MUD List
 * One person at one property gets ONE new contact; email is the one entered in
 * the source (often the office address — Dan's option (i)). Unsourced bookings
 * are reported and left on their row.
 *
 * Apply mirrors update_booking_contact's shared branch: INSERT the contact, then
 * repoint each booking WHERE id = … AND contact_id = <old row>, asserting exactly
 * one row — a booking whose contact changed since the plan is skipped, never
 * overwritten. Output carries refs, id prefixes, counts and email domains only.
 *
 * Usage:
 *   set -a; . /path/to/.env.local; set +a
 *   npx tsx scripts/repair-shared-contacts.ts                       # dry-run: plan + counts
 *   npx tsx scripts/repair-shared-contacts.ts --apply --expect=N    # write (N = planned writes from the dry-run)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseFlags, requireEnv } from './lib/cli'
import { pagedIn, uniq } from './lib/db'
import { VV_BASES } from './lib/types'
import { fetchAllMudRecords } from './lib/airtable-mud'
import { emailMatchPattern } from '../src/lib/email'
import {
  emailDomain,
  isStaffDomainEmail,
  planMudRepair,
  planResidentialRepair,
  selectSharedContacts,
  SHARED_WMRC_CONTACT_ID,
  type AirtableContactRow,
  type AuditSnapshot,
  type ContactDetails,
  type ExistingContact,
  type MudListRecord,
  type MudPlan,
  type MudProperty,
  type RepairBooking,
  type ResidentialPlan,
} from './lib/shared-contact-repair'

const PAGE = 1000
const VV_BOOKINGS_TABLE = 'tblEeFl72RfabcuFE'
const KWN_BASE = 'apppzIjIc05ghcixH' // "Kwinana Pre-booked Verge Collection"
const KWN_BOOKINGS_ALL = 'tblthTRXTHTvUkxBk'
const MAIN_BASE = VV_BASES.find((b) => b.key === 'main')!.baseId
const MUD_BASE_BY_AREA: Record<string, string> = {
  SUB: VV_BASES.find((b) => b.key === 'sub')!.baseId,
  VIC: VV_BASES.find((b) => b.key === 'vic')!.baseId,
}
const FIX_LIVE_AT = '2026-10-12T15:25:00Z' // PR #629 live: rewrites after this are a surprise
// Strata links ops must confirm before anything changes (Dan, 13/10): EAS-MUD-25's
// manager isn't in the MUD List; its history points at Magix (d46aef30) — unconfirmed.
const HELD_STRATA_LINKS = new Set(['EAS-MUD-25'])
const REF_SHAPE = /^[A-Z0-9-]+$/

const short = (id: string | null | undefined) => (id ?? '').slice(0, 8)

interface BookingRow {
  id: string
  ref: string
  type: string
  created_via: string
  created_at: string
  contact_id: string
  property_id: string | null
  client_id: string
}
interface PropertyRow {
  id: string
  is_mud: boolean | null
  mud_code: string | null
  strata_contact_id: string | null
  external_source: string | null
  external_id: string | null
  collection_area_id: string
}
const PROPERTY_COLS = 'id, is_mud, mud_code, strata_contact_id, external_source, external_id, collection_area_id'

// ─── Loaders (read-only) ──────────────────────────────────────────────────────

async function pageAll<T>(label: string, query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1)
    if (error) throw new Error(`load ${label}: ${error.message}`)
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE) break
  }
  return out
}

/** Contacts on an operator/council domain (filtered precisely on the domain later) + the WMRC row. */
async function loadCandidateContacts(verco: SupabaseClient) {
  const rows = await pageAll<{ id: string; email: string | null }>('contacts', (from, to) =>
    verco
      .from('contacts')
      .select('id, email')
      .or('email.ilike."%dmwaste%",email.ilike."%verco.au%",email.ilike."%wmrc%"')
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (!rows.some((r) => r.id === SHARED_WMRC_CONTACT_ID)) {
    const { data, error } = await verco.from('contacts').select('id, email').eq('id', SHARED_WMRC_CONTACT_ID)
    if (error) throw new Error(`load shared contact: ${error.message}`)
    rows.push(...((data ?? []) as Array<{ id: string; email: string | null }>))
  }
  return rows
}

async function loadAirtableContacts(token: string, base: string, table: string, refs: string[]): Promise<AirtableContactRow[]> {
  const out: AirtableContactRow[] = []
  const safe = refs.filter((r) => REF_SHAPE.test(r))
  for (let i = 0; i < safe.length; i += 30) {
    const formula = `OR(${safe.slice(i, i + 30).map((r) => `{Booking_Ref}="${r}"`).join(',')})`
    let offset: string | undefined
    do {
      const params = new URLSearchParams({ pageSize: '100', filterByFormula: formula })
      for (const f of ['Booking_Ref', 'Contact_Name', 'Contact_Email', 'Contact_Phone']) params.append('fields[]', f)
      if (offset) params.set('offset', offset)
      const body = await airtableFetch<{ records: Array<{ id: string; fields: Record<string, unknown> }>; offset?: string }>(
        `https://api.airtable.com/v0/${base}/${table}?${params}`,
        token,
      )
      for (const rec of body.records) {
        const f = rec.fields
        out.push({
          base,
          recordId: rec.id,
          ref: String(f['Booking_Ref'] ?? '').trim(),
          name: String(f['Contact_Name'] ?? ''),
          email: String(f['Contact_Email'] ?? ''),
          phone: String(f['Contact_Phone'] ?? ''),
        })
      }
      offset = body.offset
    } while (offset)
  }
  return out
}

async function airtableFetch<T>(url: string, token: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) return (await res.json()) as T
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }
    throw new Error(`Airtable HTTP ${res.status} (${url.split('?')[0]})`)
  }
}

/** Existing contacts carrying each planned email, with where they're used (for reuse decisions). */
async function loadExistingByEmail(verco: SupabaseClient, emails: string[]): Promise<Map<string, ExistingContact[]>> {
  const rows: Array<{ id: string; email: string; first_name: string; last_name: string; mobile_e164: string | null }> = []
  for (const e of emails) {
    const page = await pageAll<(typeof rows)[number]>('contacts by email', (from, to) =>
      verco.from('contacts').select('id, email, first_name, last_name, mobile_e164').ilike('email', emailMatchPattern(e)).order('id', { ascending: true }).range(from, to),
    )
    rows.push(...page)
  }
  const ids = uniq(rows.map((r) => r.id))
  const bookings = await pagedIn<{ contact_id: string; property_id: string | null; type: string }>(verco, 'booking', 'contact_id, property_id, type', 'contact_id', ids)
  const props = await pagedIn<PropertyRow>(verco, 'eligible_properties', PROPERTY_COLS, 'id', uniq(bookings.map((b) => b.property_id).filter((x): x is string => !!x)))
  const isMud = new Map(props.map((p) => [p.id, !!p.is_mud]))
  const strata = await pagedIn<{ strata_contact_id: string }>(verco, 'eligible_properties', 'strata_contact_id', 'strata_contact_id', ids)
  const strataIds = new Set(strata.map((s) => s.strata_contact_id))

  const out = new Map<string, ExistingContact[]>()
  for (const r of rows) {
    const propertyIds = uniq(
      bookings
        .filter((b) => b.contact_id === r.id && b.type !== 'Illegal Dumping' && b.type !== 'MUD' && b.property_id && !isMud.get(b.property_id))
        .map((b) => b.property_id!),
    )
    const key = r.email.trim().toLowerCase()
    out.set(key, [
      ...(out.get(key) ?? []),
      { id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name, mobile: r.mobile_e164, propertyIds, isStrataContact: strataIds.has(r.id) },
    ])
  }
  return out
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

interface FullPlan {
  shared: Set<string>
  residential: ResidentialPlan
  mud: MudPlan
}

async function buildPlan(verco: SupabaseClient, token: string) {
  const clients = await pageAll<{ id: string; slug: string }>('client', (f, t) => verco.from('client').select('id, slug').order('id', { ascending: true }).range(f, t))
  const slugOf = new Map(clients.map((c) => [c.id, c.slug]))
  const areas = await pageAll<{ id: string; code: string }>('collection_area', (f, t) => verco.from('collection_area').select('id, code').order('id', { ascending: true }).range(f, t))
  const areaCode = new Map(areas.map((a) => [a.id, a.code]))

  const candidates = await loadCandidateContacts(verco)
  const candidateIds = candidates.map((c) => c.id)
  const bookingRows = await pagedIn<BookingRow>(verco, 'booking', 'id, ref, type, created_via, created_at, contact_id, property_id, client_id', 'contact_id', candidateIds)
  const propRows = await pagedIn<PropertyRow>(verco, 'eligible_properties', PROPERTY_COLS, 'id', uniq(bookingRows.map((b) => b.property_id).filter((x): x is string => !!x)))
  const propById = new Map(propRows.map((p) => [p.id, p]))

  const all: RepairBooking[] = bookingRows.map((b) => ({
    id: b.id,
    ref: b.ref,
    clientSlug: slugOf.get(b.client_id) ?? b.client_id.slice(0, 8),
    type: b.type,
    createdVia: b.created_via,
    createdAt: b.created_at,
    contactId: b.contact_id,
    propertyId: b.property_id,
    isMudProperty: !!(b.property_id && propById.get(b.property_id)?.is_mud),
  }))
  const shared = selectSharedContacts(candidates, all)
  const sharedIds = [...shared]

  const inScope = all.filter((b) => shared.has(b.contactId) && b.type !== 'Illegal Dumping')
  const mudBookings = inScope.filter((b) => b.type === 'MUD' || b.isMudProperty)
  const residentialBookings = inScope.filter((b) => !(b.type === 'MUD' || b.isMudProperty))

  const strataRows = await pagedIn<PropertyRow>(verco, 'eligible_properties', PROPERTY_COLS, 'strata_contact_id', sharedIds)
  const toMud = (p: PropertyRow): MudProperty => ({
    id: p.id,
    mudCode: p.mud_code,
    areaCode: areaCode.get(p.collection_area_id) ?? '',
    airtableBase: MUD_BASE_BY_AREA[areaCode.get(p.collection_area_id) ?? ''] ?? MAIN_BASE,
    strataContactId: p.strata_contact_id,
    externalSource: p.external_source,
    externalId: p.external_id,
  })
  const strataLinked = strataRows.map(toMud).filter((p) => !HELD_STRATA_LINKS.has((p.mudCode ?? '').toUpperCase()))
  const held = strataRows.filter((p) => HELD_STRATA_LINKS.has((p.mud_code ?? '').toUpperCase())).map((p) => p.mud_code!)

  // Sources.
  const audit = (
    await pagedIn<{ id: string; record_id: string; created_at: string; new_data: Record<string, unknown> | null }>(
      verco,
      'audit_log',
      'id, record_id, created_at, new_data',
      'record_id',
      sharedIds,
      (q) => q.eq('table_name', 'contacts'),
    )
  ).map((r): AuditSnapshot => ({ id: r.id, recordId: r.record_id, createdAt: r.created_at, newData: r.new_data }))

  const legacyRefs = (slug: string) => uniq(residentialBookings.filter((b) => b.createdVia === 'legacy' && b.clientSlug === slug).map((b) => b.ref))
  const airtable: AirtableContactRow[] = []
  for (const base of VV_BASES) airtable.push(...(await loadAirtableContacts(token, base.baseId, VV_BOOKINGS_TABLE, legacyRefs('vergevalet'))))
  airtable.push(...(await loadAirtableContacts(token, KWN_BASE, KWN_BOOKINGS_ALL, legacyRefs('kwn'))))
  const otherLegacy = residentialBookings.filter((b) => b.createdVia === 'legacy' && b.clientSlug !== 'vergevalet' && b.clientSlug !== 'kwn')
  if (otherLegacy.length) console.log(`  ⚠ ${otherLegacy.length} legacy bookings on another client have no Airtable source wired`)
  const airtableByRef = new Map<string, AirtableContactRow[]>()
  for (const r of airtable) airtableByRef.set(r.ref, [...(airtableByRef.get(r.ref) ?? []), r])

  const mudPropIds = uniq(mudBookings.map((b) => b.propertyId).filter((x): x is string => !!x))
  const mudProps = (await pagedIn<PropertyRow>(verco, 'eligible_properties', PROPERTY_COLS, 'id', mudPropIds)).map(toMud)
  const mudBases = uniq([...mudProps, ...strataLinked].map((p) => p.airtableBase))
  const mudRecords: MudListRecord[] = []
  for (const base of mudBases) {
    for (const r of await fetchAllMudRecords(token, base)) {
      mudRecords.push({ base, id: r.id, mudRef: r.mudRef, contactName: r.contactName, contactNumber: r.contactNumber, email: r.email })
    }
  }
  const strataContacts = await pagedIn<{ id: string; email: string }>(verco, 'contacts', 'id, email', 'id', uniq(mudProps.map((p) => p.strataContactId).filter((x): x is string => !!x)))
  const contactEmailById = new Map(strataContacts.map((c) => [c.id, c.email]))

  // Plan twice: first to learn the emails, then with the existing contacts behind them.
  const mudInput = { mudBookings, propertiesById: new Map(mudProps.map((p) => [p.id, p])), strataLinkedToShared: strataLinked, contactEmailById, mudRecords, shared }
  const currentEmailById = new Map(candidates.map((c) => [c.id, c.email]))
  const draft = planResidentialRepair({ bookings: residentialBookings, audit, airtableByRef, existingByEmail: new Map(), shared, currentEmailById })
  const draftMud = planMudRepair({ ...mudInput, existingByEmail: new Map() })
  const emails = uniq([...draft.groups.map((g) => g.details.email), ...draftMud.strataGroups.map((g) => g.details.email)])
  const existingByEmail = await loadExistingByEmail(verco, emails)

  const plan: FullPlan = {
    shared,
    residential: planResidentialRepair({ bookings: residentialBookings, audit, airtableByRef, existingByEmail, shared, currentEmailById }),
    mud: planMudRepair({ ...mudInput, existingByEmail }),
  }
  return { plan, candidates, all, inScope, audit, airtable, held }
}

// ─── Report ───────────────────────────────────────────────────────────────────

function pad(s: string | number, n: number) {
  return String(s).padEnd(n)
}

function printReport(ctx: Awaited<ReturnType<typeof buildPlan>>) {
  const { plan, candidates, all, inScope, audit, airtable, held } = ctx
  const { residential: res, mud } = plan
  const emailOf = new Map(candidates.map((c) => [c.id, c.email]))

  console.log(`\nShared contact rows: ${plan.shared.size}`)
  for (const id of [...plan.shared].sort()) {
    const on = all.filter((b) => b.contactId === id)
    const byClient = new Map<string, number>()
    for (const b of on.filter((b) => b.type !== 'Illegal Dumping')) byClient.set(b.clientSlug, (byClient.get(b.clientSlug) ?? 0) + 1)
    const ids = on.filter((b) => b.type === 'Illegal Dumping').length
    console.log(`  ${short(id)}  @${pad(emailDomain(emailOf.get(id)), 26)} ${[...byClient].map(([c, n]) => `${c} ${n}`).join(', ')}${ids ? `  (+${ids} Illegal Dumping, left as is)` : ''}`)
  }
  const below = candidates.filter((c) => !plan.shared.has(c.id) && isStaffDomainEmail(c.email))
  const belowWithBookings = below.filter((c) => all.some((b) => b.contactId === c.id && b.type !== 'Illegal Dumping'))
  console.log(`  Staff-domain contacts below the 2-property rule (not repaired): ${below.length} (${belowWithBookings.length} with resident/MUD bookings: ${belowWithBookings.map((c) => short(c.id)).join(', ') || '—'})`)

  // Counts: client × source.
  type Row = { bookings: number; newContacts: number; reused: number }
  const table = new Map<string, Row>()
  const bump = (k: string, f: keyof Row, n = 1) => {
    const r = table.get(k) ?? { bookings: 0, newContacts: 0, reused: 0 }
    r[f] += n
    table.set(k, r)
  }
  for (const g of res.groups) {
    for (const b of g.bookings) bump(`${g.clientSlug}|${b.source === 'audit' ? 'audit snapshot' : 'Airtable master'}`, 'bookings')
    bump(`${g.clientSlug}|${g.source === 'audit' ? 'audit snapshot' : 'Airtable master'}`, g.reuseContactId ? 'reused' : 'newContacts')
  }
  const slugOfRef = new Map(inScope.map((b) => [b.ref, b.clientSlug]))
  for (const m of mud.bookingRepoints) bump(`${slugOfRef.get(m.ref) ?? '?'}|MUD list`, 'bookings')
  for (const u of res.unsourced) bump(`${u.clientSlug}|unsourced`, 'bookings')
  for (const u of mud.unsourced.filter((u) => u.kind === 'booking')) bump(`${slugOfRef.get(u.ref) ?? '?'}|unsourced`, 'bookings')

  console.log(`\n${pad('Client', 12)}${pad('Source', 18)}${pad('Bookings', 10)}${pad('New contacts', 14)}Reuse existing`)
  let tb = 0, tn = 0, tr = 0
  for (const [k, r] of [...table].sort()) {
    const [client, source] = k.split('|')
    console.log(`${pad(client!, 12)}${pad(source!, 18)}${pad(r.bookings, 10)}${pad(r.newContacts, 14)}${r.reused}`)
    tb += r.bookings; tn += r.newContacts; tr += r.reused
  }
  console.log(`${pad('TOTAL', 30)}${pad(tb, 10)}${pad(tn, 14)}${tr}`)
  console.log(`(MUD bookings repoint to their property's existing strata contact — no new contact.)`)

  const strataLinks = mud.strataGroups.reduce((n, g) => n + g.links.length, 0)
  console.log(`\nMUD strata links on a shared row: ${strataLinks + mud.unsourced.filter((u) => u.kind === 'strata link').length + held.length}`)
  for (const g of mud.strataGroups) {
    console.log(`  ${g.links.map((l) => l.mudCode).join(', ')} → ${g.reuseContactId ? `reuse ${short(g.reuseContactId)}` : 'one new contact'} (@${emailDomain(g.details.email)})`)
  }
  for (const m of mud.bookingRepoints) console.log(`  MUD booking ${m.ref}: ${short(m.oldContactId)} → strata contact ${short(m.newContactId)}`)
  if (held.length) console.log(`  Held, not planned (ops to confirm the strata manager): ${held.join(', ')}`)

  const allUnsourced = [...res.unsourced.map((u) => ({ ref: u.ref, who: `${u.clientSlug} ${short(u.contactId)}`, reason: u.reason })), ...mud.unsourced.map((u) => ({ ref: u.ref, who: `MUD ${u.kind}`, reason: u.reason }))]
  console.log(`\nUnsourced (left on their row): ${allUnsourced.length}`)
  for (const u of allUnsourced) console.log(`  ${pad(u.ref, 28)} ${pad(u.who, 20)} ${u.reason}`)

  // Notes worth a human look.
  console.log(`\nNotes:`)
  const domains = new Map<string, number>()
  for (const g of res.groups) domains.set(emailDomain(g.details.email), (domains.get(emailDomain(g.details.email)) ?? 0) + 1)
  console.log(`  Email domains on planned resident contacts: ${[...domains].sort((a, b) => b[1] - a[1]).map(([d, n]) => `@${d} ${n}`).join(', ')}`)
  const groupsMulti = res.groups.filter((g) => g.bookings.length > 1)
  console.log(`  Groups with several bookings (same person, same property): ${groupsMulti.length} (${groupsMulti.reduce((n, g) => n + g.bookings.length, 0)} bookings)`)
  console.log(`  Groups mixing audit + Airtable sources: ${res.groups.filter((g) => new Set(g.bookings.map((b) => b.source)).size > 1).length}`)
  const refLists = (xs: string[][]) => (xs.length ? ` — ${xs.map((x) => x.join(',')).join(' | ')}` : '')
  console.log(`  Properties getting more than one person (different names/mobiles, one contact each): ${res.notes.propertiesWithSeveralPeople.length}${refLists(res.notes.propertiesWithSeveralPeople)}`)
  console.log(`  Same person + property but different emails across bookings (latest used): ${res.notes.emailConflicts.length}${refLists(res.notes.emailConflicts)}`)
  const fixes = new Map<string, number>()
  for (const f of [...res.groups, ...mud.strataGroups].map((g) => g.emailFix)) {
    if (f) fixes.set(`@${f.from} → @${f.to} (${f.via})`, (fixes.get(`@${f.from} → @${f.to} (${f.via})`) ?? 0) + 1)
  }
  console.log(`  Mistyped D&M domains corrected, planned contacts: ${[...fixes.values()].reduce((a, b) => a + b, 0)}${fixes.size ? ` — ${[...fixes].sort().map(([k, n]) => `${k}: ${n}`).join('; ')}` : ''}`)
  console.log(`  Refs with duplicate (identical) Airtable rows: ${res.notes.duplicateAirtableRefs.join(', ') || 'none'}`)
  const refUse = new Map<string, number>()
  for (const b of inScope) refUse.set(b.ref, (refUse.get(b.ref) ?? 0) + 1)
  const sharedRefs = [...refUse].filter(([, n]) => n > 1).map(([r]) => r)
  console.log(`  Refs carried by more than one in-scope booking (one source row → several bookings): ${sharedRefs.join(', ') || 'none'}`)
  const basesHit = new Map<string, number>()
  for (const r of airtable) basesHit.set(r.base, (basesHit.get(r.base) ?? 0) + 1)
  console.log(`  Airtable rows fetched by base: ${[...basesHit].map(([b, n]) => `${b} ${n}`).join(', ') || 'none'}`)
  const late = audit.filter((a) => Date.parse(a.createdAt) > Date.parse(FIX_LIVE_AT))
  console.log(`  Contact rewrites on shared rows after 12/10 15:25 UTC: ${late.length}${late.length ? ` — ${late.map((a) => `${short(a.recordId)} @ ${a.createdAt}`).join('; ')}` : ''}`)
  const reuse = res.groups.filter((g) => g.reuseContactId)
  if (reuse.length) console.log(`  Reusing existing contacts: ${reuse.map((g) => `${short(g.reuseContactId)} (${g.bookings.map((b) => b.ref).join(',')})`).join('; ')}`)
  const leftOnWmrc = all.filter((b) => b.contactId === SHARED_WMRC_CONTACT_ID).length - [...res.groups.flatMap((g) => g.bookings), ...mud.bookingRepoints].filter((b) => b.oldContactId === SHARED_WMRC_CONTACT_ID).length
  console.log(`  Bookings left on ${short(SHARED_WMRC_CONTACT_ID)} after the plan: ${leftOnWmrc}`)
}

function writeCount(plan: FullPlan): number {
  return (
    plan.residential.groups.reduce((n, g) => n + g.bookings.length, 0) +
    plan.mud.bookingRepoints.length +
    plan.mud.strataGroups.reduce((n, g) => n + g.links.length, 0)
  )
}

// ─── Apply ────────────────────────────────────────────────────────────────────

async function insertContact(verco: SupabaseClient, d: ContactDetails): Promise<string> {
  const { data, error } = await verco
    .from('contacts')
    .insert({ first_name: d.firstName, last_name: d.lastName, email: d.email, mobile_e164: d.mobile })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert contact: ${error?.message ?? 'no row'}`)
  return (data as { id: string }).id
}

/** Repoint one booking, only if it still sits on `oldContactId`. True when exactly one row moved. */
async function repoint(verco: SupabaseClient, bookingId: string, oldContactId: string, newContactId: string): Promise<boolean> {
  const { data, error } = await verco.from('booking').update({ contact_id: newContactId }).eq('id', bookingId).eq('contact_id', oldContactId).select('id')
  if (error) throw new Error(error.message)
  return (data ?? []).length === 1
}

async function applyPlan(verco: SupabaseClient, plan: FullPlan) {
  const r = { contactsCreated: 0, contactsReused: 0, repointed: 0, skipped: [] as string[], failed: [] as string[] }

  for (const g of plan.residential.groups) {
    try {
      // Only create a contact if at least one booking is still on its shared row.
      const { data, error } = await verco.from('booking').select('id, contact_id').in('id', g.bookings.map((b) => b.id))
      if (error) throw new Error(error.message)
      const current = new Map(((data ?? []) as Array<{ id: string; contact_id: string }>).map((x) => [x.id, x.contact_id]))
      const live = g.bookings.filter((b) => current.get(b.id) === b.oldContactId)
      for (const b of g.bookings.filter((b) => !live.includes(b))) r.skipped.push(`${b.ref} (contact changed since plan)`)
      if (!live.length) continue
      const target = g.reuseContactId ?? (await insertContact(verco, g.details))
      if (g.reuseContactId) r.contactsReused++
      else r.contactsCreated++
      for (const b of live) {
        if (await repoint(verco, b.id, b.oldContactId, target)) {
          r.repointed++
          console.log(`  ✓ ${b.ref}: ${short(b.oldContactId)} → ${short(target)}`)
        } else r.skipped.push(`${b.ref} (contact changed during apply)`)
      }
    } catch (err) {
      r.failed.push(`${g.bookings.map((b) => b.ref).join(',')}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const g of plan.mud.strataGroups) {
    try {
      const target = g.reuseContactId ?? (await insertContact(verco, g.details))
      if (g.reuseContactId) r.contactsReused++
      else r.contactsCreated++
      for (const l of g.links) {
        const { data, error } = await verco
          .from('eligible_properties')
          .update({ strata_contact_id: target })
          .eq('id', l.propertyId)
          .eq('strata_contact_id', l.oldContactId)
          .select('id')
        if (error) throw new Error(error.message)
        if ((data ?? []).length === 1) {
          r.repointed++
          console.log(`  ✓ ${l.mudCode} strata: ${short(l.oldContactId)} → ${short(target)}`)
        } else r.skipped.push(`${l.mudCode} strata link (changed since plan)`)
      }
    } catch (err) {
      r.failed.push(`${g.links.map((l) => l.mudCode).join(',')}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const m of plan.mud.bookingRepoints) {
    try {
      if (await repoint(verco, m.id, m.oldContactId, m.newContactId)) {
        r.repointed++
        console.log(`  ✓ ${m.ref}: ${short(m.oldContactId)} → ${short(m.newContactId)}`)
      } else r.skipped.push(`${m.ref} (contact changed since plan)`)
    } catch (err) {
      r.failed.push(`${m.ref}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`\nApplied: ${r.repointed} repointed · ${r.contactsCreated} contacts created · ${r.contactsReused} reused · ${r.skipped.length} skipped · ${r.failed.length} failed`)
  for (const s of r.skipped) console.log(`  SKIPPED ${s}`)
  for (const f of r.failed) console.log(`  FAILED ${f}`)
  if (r.failed.length || r.skipped.length) process.exitCode = 1
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseFlags(process.argv)
  const unknown = Object.keys(flags).filter((k) => !['apply', 'expect'].includes(k))
  if (unknown.length) {
    console.error(`Unknown flag(s): ${unknown.join(', ')}`)
    process.exit(1)
  }
  const apply = !!flags.apply
  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  const token = requireEnv('AIRTABLE_TOKEN')

  console.log(`Shared-contact repair (${apply ? 'APPLY' : 'DRY RUN'})`)
  const ctx = await buildPlan(verco, token)
  printReport(ctx)
  const writes = writeCount(ctx.plan)

  if (!apply) {
    console.log(`\nDRY RUN — nothing written. ${writes} planned writes; apply with: --apply --expect=${writes}`)
    return
  }
  if (Number(flags.expect) !== writes) {
    console.error(`\nRefusing to apply: --expect=${String(flags.expect ?? '')} but the plan now has ${writes} writes. Re-run the dry-run and review.`)
    process.exit(1)
  }
  await applyPlan(verco, ctx.plan)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
