// scripts/import-vv-bookings-csv.ts
/**
 * Import a Verge Valet council's bookings from an Airtable `Bookings` MASTER
 * CSV export into Verco, ahead of that council's cutover.
 *
 * Why a CSV: the Airtable MCP/REST path has proven fiddly; Dan exports the
 * master view (NEVER a `BR - <CODE>` intake table — see memory
 * `verco-legacy-import-airtable-duplicates`) and hands the file over.
 *
 * What it loads (per row, collection date >= --since, status != Cancelled):
 *   - Completed / Non-Conformance   → inserted with that terminal status so the
 *                                     FY allocation counter (`get_property_fy_usage`)
 *                                     sees the usage. No stops — history only.
 *   - Booked / Place Out Issued     → Confirmed (future) — the 15:25 cron advances
 *                                     them to Scheduled + the push EF creates stops.
 *                                     Red Line #5: never set Scheduled here.
 *   - Past-dated Booked/POI         → skipped + reported (outcome unknown).
 *
 * Match: Verco VV `eligible_properties.address` is stored in Airtable's raw
 * format (e.g. `126 Shakespeare ST MOUNT HAWTHORN`, no postcode), so we match
 * on a whitespace/case-normalised EXACT address. Anything that doesn't resolve
 * to exactly one property is a reported skip, never a guess.
 *
 * The Airtable `Booking_Ref` becomes `booking.ref`, giving the two systems a
 * durable join key (the Stage-1 import lacked one).
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/import-vv-bookings-csv.ts --file="path.csv" --area=VIN            # dry run
 *   npx tsx scripts/import-vv-bookings-csv.ts --file="path.csv" --area=VIN --apply    # write
 *   optional: --since=2026-07-01 (default)  --refs=VIN-B-1,VIN-B-2 (subset)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import { normaliseWasteLocation } from './lib/reconcile'
import { pagedIn } from './lib/db'
import { timestamp } from './lib/report'
import { parseCsv } from './lib/csv'

const SERVICE = {
  bulk: '756932e9-f6da-40e4-bda3-cd63feba0bd0',
  green: '888fd3d5-64db-43f8-b849-f375796d8610',
  mattress: '9a0538d8-111c-452a-9483-3d20b07725a4',
} as const

const TODAY = new Date().toISOString().slice(0, 10)

import type { CsvRow as Row } from './lib/csv'
export type Parsed = {
  ref: string
  address: string
  status: string
  date: string | null
  location: string
  notes: string
  contactName: string
  contactEmail: string
  contactPhone: string
  services: { service_id: string; qty: number; is_extra: boolean }[]
}

const MONTHS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 }
/** Airtable lookup date "July 7, 2026" → "2026-07-07". */
export function parseDate(s: string): string | null {
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(s.trim())
  if (!m) return null
  const mo = MONTHS[m[1]!.toLowerCase()]
  if (!mo) return null
  return `${m[3]}-${String(mo).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
}

export function normAddr(a: string): string {
  return a.toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Looser key for the rows exact-match misses: Verco holds a minority of VIN
 * addresses in Google's geocoded shape ("12/49 Elizabeth St, North Perth WA
 * 6006, Australia") or with a stray space in the unit ("2 /64 Brady ST"), while
 * the master has "12/49 Elizabeth ST NORTH PERTH" / "31 GILL STREET North Perth".
 * Key = `<number> <street-name> <suburb…>` with the street TYPE token dropped
 * and state/postcode/country stripped. Ambiguity-guarded like the exact map.
 */
export function looseKey(a: string): string | null {
  const t = a
    .toUpperCase()
    .replace(/,\s*AUSTRALIA\s*$/, '')
    .replace(/\bWA\s+\d{4}\b/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
  const ni = t.findIndex((x) => /^\d/.test(x))
  if (ni < 0 || t.length < ni + 4) return null
  const number = t[ni]!, street = t[ni + 1]!, rest = t.slice(ni + 3) // ni+2 = street type, dropped
  return `${number} ${street} ${rest.join(' ')}`
}

function n(s: string | undefined): number {
  const v = Number(s ?? 0)
  return Number.isFinite(v) ? v : 0
}

export function parseRow(r: Row): Parsed {
  const bulk = n(r['No_Bulk']), green = n(r['No_Green'])
  const vveBulk = n(r['VVE_Bulk']), vveGreen = n(r['VVE_Green']), vveMatt = n(r['VVE_Mattress'])
  const services: Parsed['services'] = []
  // No_Bulk/No_Green are the TOTAL booked units; VVE_* is the paid portion of
  // that total. Split so paid units carry is_extra=true (price 0 — already paid
  // in Airtable; a non-zero price here would show as Verco revenue).
  const push = (id: string, total: number, paid: number) => {
    const p = Math.min(paid, total)
    if (total - p > 0) services.push({ service_id: id, qty: total - p, is_extra: false })
    if (p > 0) services.push({ service_id: id, qty: p, is_extra: true })
  }
  push(SERVICE.bulk, bulk, vveBulk)
  push(SERVICE.green, green, vveGreen)
  if (vveMatt > 0) services.push({ service_id: SERVICE.mattress, qty: vveMatt, is_extra: true })
  return {
    ref: r['Booking_Ref'] ?? '',
    address: r['Eligible Properties'] ?? '',
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

export function targetStatus(status: string, date: string, today = TODAY): 'Completed' | 'Non-conformance' | 'Confirmed' | null {
  if (status === 'Completed') return 'Completed'
  if (status === 'Non-Conformance') return 'Non-conformance'
  if (status === 'Booked' || status === 'Place Out Issued' || status === 'Scheduled') return date >= today ? 'Confirmed' : null
  return null
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const file = typeof flags.file === 'string' ? flags.file : null
  const areaCode = typeof flags.area === 'string' ? flags.area : null
  const since = typeof flags.since === 'string' ? flags.since : '2026-07-01'
  const onlyRefs = typeof flags.refs === 'string' ? new Set(flags.refs.split(',').map((s) => s.trim()).filter(Boolean)) : null
  if (!file || !areaCode) { console.error('Usage: --file=<csv> --area=<CODE> [--since=YYYY-MM-DD] [--refs=a,b] [--apply]'); process.exit(1) }
  const unknown = Object.keys(flags).filter((k) => !['apply', 'file', 'area', 'since', 'refs'].includes(k))
  if (unknown.length) { console.error(`Unknown flag(s): ${unknown.join(', ')}`); process.exit(1) }

  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  console.log(`Import VV bookings CSV → ${areaCode}  (${apply ? 'APPLY' : 'DRY RUN'})  today=${TODAY}  since=${since}`)

  const { data: area, error: aErr } = await verco.from('collection_area').select('id, client_id, contractor_id, code').eq('code', areaCode).single()
  if (aErr || !area) throw new Error(`collection_area ${areaCode}: ${aErr?.message ?? 'not found'}`)
  const { data: fy } = await verco.from('financial_year').select('id, start_date').eq('is_current', true).single()
  if (!fy) throw new Error('no current financial_year')
  if (since < (fy.start_date as string)) throw new Error(`--since ${since} predates the current FY (${fy.start_date}); rows would be stamped with the wrong fy_id`)

  // Rows
  const all = parseCsv(readFileSync(file, 'utf8')).map(parseRow)
  const inWindow = all.filter((p) => p.date && p.date >= since && (!onlyRefs || onlyRefs.has(p.ref)))
  console.log(`CSV rows: ${all.length}; with collection date >= ${since}: ${inWindow.length}`)

  // Verco state
  const props = await pagedIn<{ id: string; address: string | null; latitude: number | null; longitude: number | null }>(
    verco, 'eligible_properties', 'id, address, latitude, longitude', 'collection_area_id', [area.id as string],
  )
  const propByAddr = new Map<string, { id: string; lat: number | null; lng: number | null; geo: string }>()
  const ambiguous = new Set<string>()
  for (const p of props) {
    if (!p.address) continue
    const k = normAddr(p.address)
    if (propByAddr.has(k)) ambiguous.add(k)
    else propByAddr.set(k, { id: p.id, lat: p.latitude, lng: p.longitude, geo: p.address })
  }
  const looseByKey = new Map<string, { id: string; lat: number | null; lng: number | null; geo: string }>()
  const looseAmbiguous = new Set<string>()
  for (const p of props) {
    if (!p.address) continue
    const k = looseKey(p.address)
    if (!k) continue
    if (looseByKey.has(k)) looseAmbiguous.add(k)
    else looseByKey.set(k, { id: p.id, lat: p.latitude, lng: p.longitude, geo: p.address })
  }
  console.log(`Verco ${areaCode} properties: ${props.length} (${ambiguous.size} duplicate normalised addresses; ${looseAmbiguous.size} loose-key collisions)`)

  const cdRows = await pagedIn<{ id: string; date: string }>(verco, 'collection_date', 'id, date', 'collection_area_id', [area.id as string])
  const cdByDate = new Map(cdRows.map((c) => [c.date, c.id]))
  const cdDate = new Map(cdRows.map((c) => [c.id, c.date]))

  const vBookings = await pagedIn<{ id: string; ref: string; property_id: string | null; status: string }>(
    verco, 'booking', 'id, ref, property_id, status', 'collection_area_id', [area.id as string],
  )
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

  // Plan
  type Plan = { p: Parsed; status: NonNullable<ReturnType<typeof targetStatus>>; propertyId: string; cdId: string; lat: number | null; lng: number | null; geo: string }
  const plans: Plan[] = []
  const skip = {
    cancelled: [] as string[], past_unresolved: [] as { ref: string; status: string; date: string }[],
    no_property: [] as { ref: string; address: string }[], ambiguous: [] as string[], no_date: [] as { ref: string; date: string }[],
    already_in_verco: [] as string[], duplicate_prop_date: [] as string[], no_email: [] as string[], no_services: [] as string[],
  }
  const seenPropDate = new Map<string, string>() // within-CSV pairs (faithful to master; reported)
  const csvDupPairs: { ref: string; twin: string }[] = []
  const looseMatched: { ref: string; csv: string; verco: string }[] = []

  for (const p of inWindow) {
    const date = p.date!
    if (p.status === 'Cancelled') { skip.cancelled.push(p.ref); continue }
    const status = targetStatus(p.status, date)
    if (!status) { skip.past_unresolved.push({ ref: p.ref, status: p.status, date }); continue }
    if (existingRefs.has(p.ref)) { skip.already_in_verco.push(p.ref); continue }
    const k = normAddr(p.address)
    if (ambiguous.has(k)) { skip.ambiguous.push(p.ref); continue }
    let prop = propByAddr.get(k)
    if (!prop) {
      const lk = looseKey(p.address)
      if (lk && looseAmbiguous.has(lk)) { skip.ambiguous.push(p.ref); continue }
      prop = lk ? looseByKey.get(lk) : undefined
      if (prop) looseMatched.push({ ref: p.ref, csv: p.address, verco: prop.geo })
    }
    if (!prop) { skip.no_property.push({ ref: p.ref, address: p.address }); continue }
    const cdId = cdByDate.get(date)
    if (!cdId) { skip.no_date.push({ ref: p.ref, date }); continue }
    if (existingPropDate.has(`${prop.id}|${date}`)) { skip.duplicate_prop_date.push(p.ref); continue }
    if (p.services.length === 0) { skip.no_services.push(p.ref); continue }
    if (!p.contactEmail) { skip.no_email.push(p.ref); continue }
    const pd = `${prop.id}|${date}`
    const twin = seenPropDate.get(pd)
    if (twin) csvDupPairs.push({ ref: p.ref, twin }); else seenPropDate.set(pd, p.ref)
    plans.push({ p, status, propertyId: prop.id, cdId, lat: prop.lat, lng: prop.lng, geo: prop.geo })
  }

  const byStatus = plans.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {})
  const stamp = timestamp()
  const reportPath = `import-vv-${areaCode}-report-${stamp}.json`
  writeFileSync(reportPath, JSON.stringify({
    area: areaCode, since, today: TODAY, apply,
    plans: plans.map((x) => ({ ref: x.p.ref, status: x.status, date: x.p.date, address: x.geo, location: x.p.location, services: x.p.services })),
    csvDupPairs, looseMatched, skip,
  }, null, 2))

  console.log('\n═════════ Import plan ═════════')
  console.log(`  would create:                  ${plans.length}   ${JSON.stringify(byStatus)}`)
  console.log(`  matched via loose key:         ${looseMatched.length} (listed in report — eyeball them)`)
  console.log(`  same property+date twice in CSV: ${csvDupPairs.length} (both kept — faithful to master; listed in report)`)
  console.log(`  skip · cancelled               ${skip.cancelled.length}`)
  console.log(`  skip · past, not closed out    ${skip.past_unresolved.length}`)
  console.log(`  skip · already in Verco (ref)  ${skip.already_in_verco.length}`)
  console.log(`  skip · property+date booked    ${skip.duplicate_prop_date.length}`)
  console.log(`  skip · no property match       ${skip.no_property.length}`)
  console.log(`  skip · ambiguous address       ${skip.ambiguous.length}`)
  console.log(`  skip · no collection_date      ${skip.no_date.length}`)
  console.log(`  skip · no email                ${skip.no_email.length}`)
  console.log(`  skip · no services             ${skip.no_services.length}`)
  console.log(`  report: ${reportPath}`)

  if (!apply) { console.log(`\nDRY RUN — re-run with --apply to create ${plans.length} bookings.`); return }

  let created = 0
  const fail: { ref: string; error: string }[] = []
  for (const pl of plans) {
    try {
      const contactId = await upsertContact(verco, pl.p)
      const { data: bk, error: bErr } = await verco
        .from('booking')
        .insert({
          ref: pl.p.ref, type: 'Residential', status: pl.status, created_via: 'legacy',
          property_id: pl.propertyId, contact_id: contactId, collection_area_id: area.id,
          client_id: area.client_id, contractor_id: area.contractor_id, fy_id: fy.id,
          location: pl.p.location, notes: pl.p.notes || null,
          latitude: pl.lat, longitude: pl.lng, geo_address: pl.geo,
        })
        .select('id')
        .single()
      if (bErr) throw new Error(bErr.message)
      const rows = pl.p.services.map((s) => ({
        booking_id: bk!.id, service_id: s.service_id, collection_date_id: pl.cdId,
        no_services: s.qty, unit_price_cents: 0, is_extra: s.is_extra,
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

if (process.argv[1]?.endsWith('import-vv-bookings-csv.ts')) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1) })
}
