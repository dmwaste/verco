// scripts/import-kwn-bookings-csv.ts
/**
 * Import KWN bookings from an Airtable "Bookings All" (master) CSV export —
 * the Kwinana runs collected under the legacy system after the FY27 start but
 * before Verco went live for KWN (6 July 2026), i.e. Wed 1 July (KWN-3) and
 * Thu 2 July (KWN-4).
 *
 * Why: `get_property_fy_usage` and the monthly client report only see Verco
 * rows. Without these, residents collected on 1–2 July show a full FY27
 * allocation (and can book extras free) and July's report undercounts two days.
 *
 * Same rules as `import-vv-bookings-csv.ts` (history only — no stops):
 *   Completed / Non-Conformance → inserted with that terminal status
 *   Booked / Place Out Issued    → Confirmed when future, else skipped+reported
 *   Cancelled                    → skipped
 * Area comes from the row's `Area_Code` ("Area 3 (Wednesday)" → KWN-3).
 * Property match uses the KWN `addrKey` (postcode-keyed; Verco holds the
 * geocoded address, the master the raw one). Units come from `Bulk_Total_All` /
 * `Green_Total_All` (they include bulk↔green swaps; the plain `_Total` cols
 * miss them) + `Mattress_Total` / `Whitegood_Total` / `E-Waste_Total`.
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/import-kwn-bookings-csv.ts --file="path.csv"            # dry run
 *   npx tsx scripts/import-kwn-bookings-csv.ts --file="path.csv" --apply    # write
 *   optional: --since=2026-07-01 (default)  --refs=KWN-1,KWN-2 (subset)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import { normaliseWasteLocation } from './lib/reconcile'
import { pagedIn } from './lib/db'
import { timestamp } from './lib/report'
import { parseCsv, type CsvRow as Row } from './lib/csv'
import { addrKey } from './lib/kwn-address'
import { parseDate, targetStatus } from './import-vv-bookings-csv'

const SERVICE = {
  bulk: '756932e9-f6da-40e4-bda3-cd63feba0bd0',
  green: '888fd3d5-64db-43f8-b849-f375796d8610',
  mattress: '9a0538d8-111c-452a-9483-3d20b07725a4',
  whitegood: '41042e2d-36ec-40a0-a51e-377c7f536ebc',
  ewaste: '8b9daf58-69b5-41d9-be2b-7e5726998650',
} as const

const TODAY = new Date().toISOString().slice(0, 10)

export type Parsed = {
  ref: string
  address: string
  areaCode: string | null
  status: string
  date: string | null
  location: string
  notes: string
  contactName: string
  contactEmail: string
  contactPhone: string
  services: { service_id: string; qty: number }[]
}

/** "Area 3 (Wednesday)" → "KWN-3". */
export function areaCodeFrom(s: string): string | null {
  const m = /^Area (\d)/.exec(s.trim())
  return m ? `KWN-${m[1]}` : null
}

function n(s: string | undefined): number {
  const v = Number(s ?? 0)
  return Number.isFinite(v) ? v : 0
}

export function parseRow(r: Row): Parsed {
  const services: Parsed['services'] = []
  const push = (id: string, qty: number) => { if (qty > 0) services.push({ service_id: id, qty }) }
  push(SERVICE.bulk, n(r['Bulk_Total_All']))
  push(SERVICE.green, n(r['Green_Total_All']))
  push(SERVICE.mattress, n(r['Mattress_Total']))
  push(SERVICE.whitegood, n(r['Whitegood_Total']))
  push(SERVICE.ewaste, n(r['E-Waste_Total']))
  return {
    ref: r['Booking_Ref'] ?? '',
    address: r['Eligible Properties'] ?? '',
    areaCode: areaCodeFrom(r['Area_Code (from Eligible Properties)'] ?? ''),
    status: r['Status'] ?? '',
    date: parseDate(r['Collection_Date (from Collection_Date)'] ?? ''),
    location: r['Waste_Location'] ? normaliseWasteLocation(r['Waste_Location']) : '',
    notes: r['Waste_Notes'] ?? '',
    contactName: r['Contact_Name'] ?? '',
    contactEmail: (r['Contact_Email'] ?? '').trim().toLowerCase(),
    contactPhone: (r['Contact_Phone'] ?? '').trim(),
    services,
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const file = typeof flags.file === 'string' ? flags.file : null
  const since = typeof flags.since === 'string' ? flags.since : '2026-07-01'
  const onlyRefs = typeof flags.refs === 'string' ? new Set(flags.refs.split(',').map((s) => s.trim()).filter(Boolean)) : null
  if (!file) { console.error('Usage: --file=<csv> [--since=YYYY-MM-DD] [--refs=a,b] [--apply]'); process.exit(1) }
  const unknown = Object.keys(flags).filter((k) => !['apply', 'file', 'since', 'refs'].includes(k))
  if (unknown.length) { console.error(`Unknown flag(s): ${unknown.join(', ')}`); process.exit(1) }

  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  console.log(`Import KWN bookings CSV  (${apply ? 'APPLY' : 'DRY RUN'})  today=${TODAY}  since=${since}`)

  const { data: areas, error: aErr } = await verco.from('collection_area').select('id, client_id, contractor_id, code').like('code', 'KWN-%')
  if (aErr || !areas?.length) throw new Error(`collection_area KWN-*: ${aErr?.message ?? 'not found'}`)
  const areaByCode = new Map(areas.map((a) => [a.code as string, a]))
  const areaIds = areas.map((a) => a.id as string)
  const { data: fy } = await verco.from('financial_year').select('id, start_date').eq('is_current', true).single()
  if (!fy) throw new Error('no current financial_year')
  if (since < (fy.start_date as string)) throw new Error(`--since ${since} predates the current FY (${fy.start_date}); rows would be stamped with the wrong fy_id`)

  const all = parseCsv(readFileSync(file, 'utf8')).map(parseRow)
  const inWindow = all.filter((p) => p.date && p.date >= since && (!onlyRefs || onlyRefs.has(p.ref)))
  console.log(`CSV rows: ${all.length}; with collection date >= ${since}: ${inWindow.length}`)

  // Properties keyed by addrKey, ambiguity-guarded (distinct addresses colliding on a key → unsafe).
  const props = await pagedIn<{ id: string; address: string | null; latitude: number | null; longitude: number | null; collection_area_id: string }>(
    verco, 'eligible_properties', 'id, address, latitude, longitude, collection_area_id', 'collection_area_id', areaIds,
  )
  const propByKey = new Map<string, { id: string; areaId: string; lat: number | null; lng: number | null; geo: string }>()
  const ambiguous = new Set<string>()
  for (const p of props) {
    if (!p.address) continue
    const k = addrKey(p.address)
    if (!k) continue
    const prev = propByKey.get(k)
    if (prev && prev.geo.toUpperCase() !== p.address.toUpperCase()) ambiguous.add(k)
    else if (!prev) propByKey.set(k, { id: p.id, areaId: p.collection_area_id, lat: p.latitude, lng: p.longitude, geo: p.address })
  }
  // Fallback for Airtable postcode typos (e.g. Leda keyed 6167 instead of 6170):
  // same key minus the postcode, ambiguity-guarded the same way.
  const noPc = (k: string) => k.replace(/ \d{4}$/, '')
  const propByLoose = new Map<string, { id: string; areaId: string; lat: number | null; lng: number | null; geo: string }>()
  const looseAmbiguous = new Set<string>()
  for (const [k, v] of propByKey) {
    const lk = noPc(k)
    const prev = propByLoose.get(lk)
    if (prev && prev.geo.toUpperCase() !== v.geo.toUpperCase()) looseAmbiguous.add(lk)
    else if (!prev) propByLoose.set(lk, v)
  }
  console.log(`Verco KWN properties: ${props.length} (${ambiguous.size} ambiguous keys)`)

  const cdRows = await pagedIn<{ id: string; date: string; collection_area_id: string }>(verco, 'collection_date', 'id, date, collection_area_id', 'collection_area_id', areaIds)
  const cdByAreaDate = new Map(cdRows.map((c) => [`${c.collection_area_id}|${c.date}`, c.id]))
  const cdDate = new Map(cdRows.map((c) => [c.id, c.date]))

  const vBookings = await pagedIn<{ id: string; ref: string; property_id: string | null }>(verco, 'booking', 'id, ref, property_id', 'collection_area_id', areaIds)
  const existingRefs = new Set(vBookings.map((b) => b.ref))
  const bookingProp = new Map(vBookings.map((b) => [b.id, b.property_id]))
  const bItems = vBookings.length
    ? await pagedIn<{ booking_id: string; collection_date_id: string | null }>(verco, 'booking_item', 'booking_id, collection_date_id', 'booking_id', vBookings.map((b) => b.id))
    : []
  const existingPropDate = new Set<string>()
  for (const it of bItems) {
    const p = bookingProp.get(it.booking_id)
    const d = it.collection_date_id ? cdDate.get(it.collection_date_id) : null
    if (p && d) existingPropDate.add(`${p}|${d}`)
  }

  type Plan = { p: Parsed; status: NonNullable<ReturnType<typeof targetStatus>>; propertyId: string; areaId: string; cdId: string; lat: number | null; lng: number | null; geo: string }
  const plans: Plan[] = []
  const skip = {
    cancelled: [] as string[], past_unresolved: [] as { ref: string; status: string; date: string }[],
    no_property: [] as { ref: string; address: string; key: string | null }[], ambiguous: [] as string[],
    no_area: [] as string[], area_mismatch: [] as { ref: string; csv: string; verco: string }[],
    no_date: [] as { ref: string; date: string }[], already_in_verco: [] as string[], duplicate_prop_date: [] as string[],
    no_email: [] as string[], no_services: [] as string[],
  }
  const seenPropDate = new Map<string, string>()
  const csvDupPairs: { ref: string; twin: string }[] = []
  const looseMatched: { ref: string; csv: string; verco: string }[] = []

  for (const p of inWindow) {
    const date = p.date!
    if (p.status === 'Cancelled') { skip.cancelled.push(p.ref); continue }
    const status = targetStatus(p.status, date)
    if (!status) { skip.past_unresolved.push({ ref: p.ref, status: p.status, date }); continue }
    if (existingRefs.has(p.ref)) { skip.already_in_verco.push(p.ref); continue }
    const csvArea = p.areaCode ? areaByCode.get(p.areaCode) : undefined
    if (!csvArea) { skip.no_area.push(p.ref); continue }
    const k = addrKey(p.address)
    if (k && ambiguous.has(k)) { skip.ambiguous.push(p.ref); continue }
    let prop = k ? propByKey.get(k) : undefined
    if (!prop && k) {
      const lk = noPc(k)
      if (looseAmbiguous.has(lk)) { skip.ambiguous.push(p.ref); continue }
      prop = propByLoose.get(lk)
      if (prop) looseMatched.push({ ref: p.ref, csv: p.address, verco: prop.geo })
    }
    if (!prop) { skip.no_property.push({ ref: p.ref, address: p.address, key: k }); continue }
    // The property's Verco area is authoritative; a CSV area that disagrees is a data problem, not a guess to make.
    if (prop.areaId !== csvArea.id) { skip.area_mismatch.push({ ref: p.ref, csv: p.areaCode!, verco: areas.find((a) => a.id === prop.areaId)?.code as string }); continue }
    const cdId = cdByAreaDate.get(`${prop.areaId}|${date}`)
    if (!cdId) { skip.no_date.push({ ref: p.ref, date }); continue }
    if (existingPropDate.has(`${prop.id}|${date}`)) { skip.duplicate_prop_date.push(p.ref); continue }
    if (p.services.length === 0) { skip.no_services.push(p.ref); continue }
    if (!p.contactEmail) { skip.no_email.push(p.ref); continue }
    const pd = `${prop.id}|${date}`
    const twin = seenPropDate.get(pd)
    if (twin) csvDupPairs.push({ ref: p.ref, twin }); else seenPropDate.set(pd, p.ref)
    plans.push({ p, status, propertyId: prop.id, areaId: prop.areaId, cdId, lat: prop.lat, lng: prop.lng, geo: prop.geo })
  }

  const byStatus = plans.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {})
  const byDate = plans.reduce<Record<string, number>>((m, x) => ((m[x.p.date!] = (m[x.p.date!] ?? 0) + 1), m), {})
  const reportPath = `import-kwn-report-${timestamp()}.json`
  writeFileSync(reportPath, JSON.stringify({
    since, today: TODAY, apply,
    plans: plans.map((x) => ({ ref: x.p.ref, status: x.status, date: x.p.date, address: x.geo, location: x.p.location, services: x.p.services })),
    csvDupPairs, looseMatched, skip,
  }, null, 2))

  console.log('\n═════════ Import plan ═════════')
  console.log(`  would create:                    ${plans.length}   ${JSON.stringify(byStatus)}   ${JSON.stringify(byDate)}`)
  console.log(`  matched ignoring postcode:       ${looseMatched.length} (listed in report — eyeball them)`)
  console.log(`  same property+date twice in CSV: ${csvDupPairs.length} (both kept — faithful to master)`)
  console.log(`  skip · cancelled                 ${skip.cancelled.length}`)
  console.log(`  skip · past, not closed out      ${skip.past_unresolved.length}`)
  console.log(`  skip · already in Verco (ref)    ${skip.already_in_verco.length}`)
  console.log(`  skip · property+date booked      ${skip.duplicate_prop_date.length}`)
  console.log(`  skip · no property match         ${skip.no_property.length}`)
  console.log(`  skip · ambiguous address         ${skip.ambiguous.length}`)
  console.log(`  skip · unknown area code         ${skip.no_area.length}`)
  console.log(`  skip · CSV area ≠ property area  ${skip.area_mismatch.length}`)
  console.log(`  skip · no collection_date        ${skip.no_date.length}`)
  console.log(`  skip · no email                  ${skip.no_email.length}`)
  console.log(`  skip · no services               ${skip.no_services.length}`)
  console.log(`  report: ${reportPath}`)

  if (!apply) { console.log(`\nDRY RUN — re-run with --apply to create ${plans.length} bookings.`); return }

  let created = 0
  const fail: { ref: string; error: string }[] = []
  for (const pl of plans) {
    const area = areaByCode.get(areas.find((a) => a.id === pl.areaId)!.code as string)!
    try {
      const contactId = await upsertContact(verco, pl.p)
      const { data: bk, error: bErr } = await verco
        .from('booking')
        .insert({
          ref: pl.p.ref, type: 'Residential', status: pl.status, created_via: 'legacy',
          property_id: pl.propertyId, contact_id: contactId, collection_area_id: pl.areaId,
          client_id: area.client_id, contractor_id: area.contractor_id, fy_id: fy.id,
          location: pl.p.location, notes: pl.p.notes || null,
          latitude: pl.lat, longitude: pl.lng, geo_address: pl.geo,
        })
        .select('id')
        .single()
      if (bErr) throw new Error(bErr.message)
      const rows = pl.p.services.map((s) => ({
        booking_id: bk!.id, service_id: s.service_id, collection_date_id: pl.cdId,
        no_services: s.qty, unit_price_cents: 0, is_extra: false,
      }))
      const { error: iErr } = await verco.from('booking_item').insert(rows)
      if (iErr) throw new Error(`items: ${iErr.message}`)
      created++
    } catch (e) {
      fail.push({ ref: pl.p.ref, error: (e as Error).message })
    }
  }
  console.log(`\nCreated ${created}/${plans.length} bookings.`)
  for (const f of fail) console.error(`  ✗ ${f.ref}: ${f.error}`)
  if (fail.length) process.exit(1)
}

async function upsertContact(verco: SupabaseClient, p: Parsed): Promise<string> {
  const { data: existing } = await verco.from('contacts').select('id').eq('email', p.contactEmail).limit(1).maybeSingle()
  if (existing) return existing.id as string
  const name = p.contactName.trim()
  const sp = name.indexOf(' ')
  const first = sp > 0 ? name.slice(0, sp) : name || 'Resident'
  const last = sp > 0 ? name.slice(sp + 1) : '—'
  const { data, error } = await verco.from('contacts').insert({ first_name: first, last_name: last, email: p.contactEmail, mobile_e164: p.contactPhone || null }).select('id').single()
  if (error) throw new Error(`contact: ${error.message}`)
  return data!.id as string
}

if (process.argv[1]?.endsWith('import-kwn-bookings-csv.ts')) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1) })
}
