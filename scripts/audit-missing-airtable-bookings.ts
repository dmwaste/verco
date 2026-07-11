// scripts/audit-missing-airtable-bookings.ts
/**
 * READ-ONLY audit: future Airtable bookings that were never imported into Verco,
 * for KWN / MOS / COT / PEP.
 *
 * Source of truth: the consolidated Airtable "Bookings" master per base
 * (the per-council BR-/A1-A4 intake tables are ignored). Bookings modified or
 * cancelled in Airtable since the 01/07 hand-over to Verco are expected drift —
 * this audit does NOT flag those. It only flags ACTIVE, FUTURE Airtable bookings
 * with no corresponding Verco booking at all.
 *
 * Two bases, two bridges (see lib/audit-match):
 *   - MOS/COT/PEP → base appWSysd50QoVaaRD, table "Bookings" — property + date.
 *   - KWN-1..4    → base apppzIjIc05ghcixH, table "Bookings All" — exact ref.
 *
 * Writes ONE CSV. Never writes to Verco or Airtable.
 *
 * Usage:
 *   set -a; . /path/to/.env.local; set +a
 *   npx tsx scripts/audit-missing-airtable-bookings.ts               # today = 2026-07-10
 *   npx tsx scripts/audit-missing-airtable-bookings.ts --from=2026-07-15
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import { loadAreaMap, loadAreaMapForClient } from './lib/area-map'
import { findMissingByPropertyDate, findMissingByRef } from './lib/audit-match'

const DEFAULT_FROM = '2026-07-10' // "future" = collection date on/after this
const RESCHEDULE_TOLERANCE_DAYS = 21
const ACTIVE = new Set(['Booked', 'Place Out Issued', 'Scheduled'])

// ── Airtable ids ────────────────────────────────────────────────────────────
const VV = {
  base: 'appWSysd50QoVaaRD',
  bookings: 'tblEeFl72RfabcuFE',
  ep: 'tbl5qHD1ZizpymXN9',
  epAddr: 'fldHwHAVRLqHhJNRG',
  f: {
    ref: 'fldqrIEIm18oTWAGg',
    status: 'fldgsq0lJYqPTPjEz',
    date: 'fldTJqqPiMPsCFWcP', // Collection_Date lookup → ["YYYY-MM-DD"]
    ep: 'fldYGXUHswF9tFQn3', // Eligible Properties link
    council: 'fldtSdAd8tPYp3ZTY', // Council_Code (from Eligible Properties) lookup
    contact: 'fldWHHh5X164Z2gvp',
    bulk: 'fldquMnXoXziV6O9l',
    green: 'fldvpxHlXrYMhDJiT',
    mattress: 'fldHpGRMDzHSlVRCH', // singleSelect "0"/"1"/…
  },
} as const

const KWN = {
  base: 'apppzIjIc05ghcixH',
  bookings: 'tblthTRXTHTvUkxBk', // "Bookings All"
  ep: 'tbly7Ruw6iOhUo5td',
  epAddr: 'fldadRrqYLFzDLVxK',
  f: {
    ref: 'fldfuWaydRMJC4DCW',
    status: 'fld5vEwbAO4aCXmAf',
    date: 'fldIMEWF9CtNlNZ8v', // Collection_Date lookup → ["YYYY-MM-DD"]
    ep: 'fldNJbqxjmjucNTjJ',
    area: 'fldiVr63Zjtj8b2PE', // Area_Code (from Eligible Properties) lookup → ["Area 2 (Tuesday)"]
    contact: 'fldLKVNVORKpIajr5',
    bulk: 'fldcFIaqo4rt76adg', // Bulk_Total
    green: 'fld9jaMzuVithdL2V', // Green_Total
    mattress: 'fldgyRXTUmP2PZqEB',
    whitegood: 'fldwZYLFW3l5PUTsa',
    ewaste: 'fldaMIpddbeMYXK81',
    ancillary: 'fldT3VYX3q2i5A6bw',
  },
} as const

type MissingRow = {
  council: string
  ref: string
  address: string
  date: string
  status: string
  contact: string
  bulk: number
  green: number
  other: number
  recordId: string
  propertyRecId: string
}

async function main() {
  const flags = parseFlags(process.argv)
  const from = typeof flags.from === 'string' ? flags.from : DEFAULT_FROM
  const token = requireEnv('AIRTABLE_TOKEN')
  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))

  console.log(`Audit: future (>= ${from}) Airtable bookings missing from Verco — KWN/MOS/COT/PEP  (READ ONLY)`)

  const missing: MissingRow[] = []
  await auditVv(verco, token, from, missing)
  await auditKwn(verco, token, from, missing)

  // Report
  missing.sort((a, b) => a.council.localeCompare(b.council) || a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref))
  const stamp = timestamp()
  const csvPath = writeCsv(missing, stamp)
  printSummary(missing)
  console.log(`\nCSV written:\n  ${csvPath}`)
}

// ── VV (MOS/COT/PEP): property + date bridge ─────────────────────────────────
async function auditVv(verco: SupabaseClient, token: string, from: string, out: MissingRow[]) {
  const councils = ['MOS', 'COT', 'PEP']
  const areaMap = await loadAreaMap(verco)
  const areaIds = councils.map((c) => areaMap.get(c)).filter((x): x is string => !!x)
  if (areaIds.length !== councils.length) throw new Error(`Missing Verco area for: ${councils.filter((c) => !areaMap.get(c)).join(', ')}`)

  // Verco: property external_id → all collection dates (any status = "imported").
  const vercoDatesByProperty = await loadVercoPropertyDates(verco, areaIds)

  // Airtable: active bookings (exclude Cancelled/Completed at source to cut
  // volume). Fetch per council so the council is known directly — the
  // "Council_Code (from Eligible Properties)" lookup resolves to linked-record
  // ids in the raw API (only ARRAYJOIN inside a formula yields the code string).
  const sources: {
    recordId: string; ref: string; status: string; date: string; propertyKey: string; council: string; contact: string; bulk: number; green: number; other: number
  }[] = []
  let rawCount = 0
  for (const c of councils) {
    const filter = `AND(FIND("${c}",ARRAYJOIN({Council_Code (from Eligible Properties)})),{Status}!="Cancelled",{Status}!="Completed")`
    const records = await airtableAll(VV.base, VV.bookings, token, Object.values(VV.f), filter)
    rawCount += records.length
    for (const r of records) {
      sources.push({
        recordId: r.id,
        ref: String(r.fields[VV.f.ref] ?? r.id),
        status: (r.fields[VV.f.status] as string) ?? '',
        date: (r.fields[VV.f.date] as string[] | undefined)?.[0] ?? '',
        propertyKey: (r.fields[VV.f.ep] as string[] | undefined)?.[0] ?? '',
        council: c,
        contact: (r.fields[VV.f.contact] as string) ?? '',
        bulk: num(r.fields[VV.f.bulk]),
        green: num(r.fields[VV.f.green]),
        other: num(r.fields[VV.f.mattress]),
      })
    }
  }
  const futureSources = sources.filter((s) => s.propertyKey && s.date >= from && ACTIVE.has(s.status))
  console.log(`  VV: ${rawCount} active Airtable rows; ${futureSources.length} future (>= ${from}).`)

  const missing = findMissingByPropertyDate(vercoDatesByProperty, futureSources, RESCHEDULE_TOLERANCE_DAYS)
  const addr = await fetchEpAddresses(VV.base, VV.ep, VV.epAddr, token, missing.map((m) => m.propertyKey))
  for (const m of missing) {
    out.push({
      council: m.council,
      ref: m.ref,
      address: addr.get(m.propertyKey) ?? '',
      date: m.date,
      status: m.status,
      contact: m.contact,
      bulk: m.bulk,
      green: m.green,
      other: m.other,
      recordId: m.recordId,
      propertyRecId: m.propertyKey,
    })
  }
  console.log(`  VV: ${missing.length} missing from Verco.`)
}

// ── KWN: exact ref bridge ────────────────────────────────────────────────────
async function auditKwn(verco: SupabaseClient, token: string, from: string, out: MissingRow[]) {
  const areaMap = await loadAreaMapForClient(verco, 'kwn')
  const areaIds = [...areaMap.values()]
  const vercoRefs = await loadVercoRefs(verco, areaIds)

  const filter = `AND({Status}!="Cancelled",{Status}!="Completed")`
  const records = await airtableAll(KWN.base, KWN.bookings, token, Object.values(KWN.f), filter)

  const sources = records
    .map((r) => ({
      recordId: r.id,
      ref: String(r.fields[KWN.f.ref] ?? r.id),
      status: (r.fields[KWN.f.status] as string) ?? '',
      date: (r.fields[KWN.f.date] as string[] | undefined)?.[0] ?? '',
      propertyKey: (r.fields[KWN.f.ep] as string[] | undefined)?.[0] ?? '',
      area: areaFromLookup((r.fields[KWN.f.area] as string[] | undefined)?.[0]),
      contact: (r.fields[KWN.f.contact] as string) ?? '',
      bulk: num(r.fields[KWN.f.bulk]),
      green: num(r.fields[KWN.f.green]),
      other: num(r.fields[KWN.f.mattress]) + num(r.fields[KWN.f.whitegood]) + num(r.fields[KWN.f.ewaste]) + num(r.fields[KWN.f.ancillary]),
    }))
    .filter((s) => s.date >= from && ACTIVE.has(s.status))

  console.log(`  KWN: ${records.length} active Airtable rows; ${sources.length} future (>= ${from}).`)

  const missing = findMissingByRef(vercoRefs, sources)
  const addr = await fetchEpAddresses(KWN.base, KWN.ep, KWN.epAddr, token, missing.map((m) => m.propertyKey))
  for (const m of missing) {
    out.push({
      council: m.area,
      ref: m.ref,
      address: addr.get(m.propertyKey) ?? '',
      date: m.date,
      status: m.status,
      contact: m.contact,
      bulk: m.bulk,
      green: m.green,
      other: m.other,
      recordId: m.recordId,
      propertyRecId: m.propertyKey,
    })
  }
  console.log(`  KWN: ${missing.length} missing from Verco.`)
}

// ── Verco loaders ────────────────────────────────────────────────────────────
async function loadVercoPropertyDates(verco: SupabaseClient, areaIds: string[]): Promise<Map<string, string[]>> {
  const bookings = await pagedIn<{ id: string; property_id: string | null }>(
    verco, 'booking', 'id, property_id', 'collection_area_id', areaIds,
  )
  const propIds = uniq(bookings.map((b) => b.property_id).filter((x): x is string => !!x))
  const props = await pagedIn<{ id: string; external_id: string | null }>(verco, 'eligible_properties', 'id, external_id', 'id', propIds)
  const extIdOf = new Map(props.map((p) => [p.id, p.external_id]))

  const ids = bookings.map((b) => b.id)
  const items = await pagedIn<{ booking_id: string; collection_date_id: string | null }>(
    verco, 'booking_item', 'booking_id, collection_date_id', 'booking_id', ids,
  )
  const dateIds = uniq(items.map((i) => i.collection_date_id).filter((x): x is string => !!x))
  const cdates = await pagedIn<{ id: string; date: string }>(verco, 'collection_date', 'id, date', 'id', dateIds)
  const dateOf = new Map(cdates.map((d) => [d.id, d.date]))

  const minDate = new Map<string, string>() // booking → earliest date
  for (const it of items) {
    const d = it.collection_date_id ? dateOf.get(it.collection_date_id) : undefined
    if (!d) continue
    const cur = minDate.get(it.booking_id)
    if (!cur || d < cur) minDate.set(it.booking_id, d)
  }

  const out = new Map<string, string[]>()
  for (const b of bookings) {
    const ext = b.property_id ? extIdOf.get(b.property_id) : null
    const d = minDate.get(b.id)
    if (!ext || !d) continue
    ;(out.get(ext) ?? out.set(ext, []).get(ext)!).push(d)
  }
  return out
}

async function loadVercoRefs(verco: SupabaseClient, areaIds: string[]): Promise<Set<string>> {
  const rows = await pagedIn<{ ref: string }>(verco, 'booking', 'ref', 'collection_area_id', areaIds)
  return new Set(rows.map((r) => r.ref))
}

// ── Airtable helpers ─────────────────────────────────────────────────────────
type AtRecord = { id: string; fields: Record<string, unknown> }

async function airtableAll(baseId: string, tableId: string, token: string, fieldIds: string[], filterByFormula?: string): Promise<AtRecord[]> {
  const out: AtRecord[] = []
  let offset: string | undefined
  do {
    const params = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' })
    for (const f of fieldIds) params.append('fields[]', f)
    if (filterByFormula) params.set('filterByFormula', filterByFormula)
    if (offset) params.set('offset', offset)
    const body = await airtableFetch<{ records: AtRecord[]; offset?: string }>(`https://api.airtable.com/v0/${baseId}/${tableId}?${params}`, token)
    out.push(...body.records)
    offset = body.offset
  } while (offset)
  return out
}

/** Resolve a set of Eligible-Properties record ids → their Address (primary field). */
async function fetchEpAddresses(baseId: string, tableId: string, addrFieldId: string, token: string, recIds: string[]): Promise<Map<string, string>> {
  const want = new Set(recIds.filter(Boolean))
  const out = new Map<string, string>()
  if (want.size === 0) return out
  const ids = [...want]
  const CHUNK = 50
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const formula = `OR(${chunk.map((id) => `RECORD_ID()="${id}"`).join(',')})`
    const recs = await airtableAll(baseId, tableId, token, [addrFieldId], formula)
    for (const r of recs) out.set(r.id, String(r.fields[addrFieldId] ?? ''))
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
    throw new Error(`Airtable HTTP ${res.status} for ${url}`)
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
function printSummary(missing: MissingRow[]) {
  const byCouncil = new Map<string, number>()
  for (const m of missing) byCouncil.set(m.council, (byCouncil.get(m.council) ?? 0) + 1)
  console.log('\n═════════ Missing-from-Verco summary ═════════')
  for (const [c, n] of [...byCouncil].sort()) console.log(`  ${c.padEnd(6)} ${n}`)
  console.log(`  ${'TOTAL'.padEnd(6)} ${missing.length}`)
}

function writeCsv(missing: MissingRow[], stamp: string): string {
  const header = 'council,airtable_ref,address,collection_date,status,contact_name,bulk,green,other,airtable_record_id'
  const rows = missing.map((m) =>
    [m.council, m.ref, m.address, m.date, m.status, m.contact, m.bulk, m.green, m.other, m.recordId].map(csvCell).join(','),
  )
  const path = `audit-missing-airtable-bookings-report-${stamp}.csv`
  writeFileSync(path, [header, ...rows].join('\n'))
  return path
}

// ── Small helpers ─────────────────────────────────────────────────────────────
async function pagedIn<T>(verco: SupabaseClient, table: string, select: string, column: string, values: string[]): Promise<T[]> {
  const out: T[] = []
  const CHUNK = 100
  const PAGE = 1000
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    // Page the rows too — a chunk can match more rows than PostgREST's max-rows cap.
    let from = 0
    while (true) {
      const { data, error } = await verco
        .from(table)
        .select(select)
        .in(column, chunk)
        .order('id', { ascending: true }) // stable order — range() pagination skips/dupes rows without it
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`load ${table}: ${error.message}`)
      if (!data || data.length === 0) break
      out.push(...(data as T[]))
      if (data.length < PAGE) break
      from += PAGE
    }
  }
  return out
}

function areaFromLookup(v: string | undefined): string {
  const m = v?.match(/Area\s*(\d)/)
  return m ? `KWN-${m[1]}` : 'KWN'
}

function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)]
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function timestamp(): string {
  const d = new Date()
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
