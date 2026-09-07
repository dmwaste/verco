// scripts/import-mud-bookings-csv.ts
/**
 * Import Verge Valet MUD bookings from an Airtable `MUD Bookings` CSV export
 * into Verco, for the councils already live on Verco. The residential master
 * import (import-vv-bookings-csv.ts) never carried these — MUD bookings live
 * in their own Airtable table with their own refs (e.g. MOS-MUD-07-1007).
 *
 * What it loads (per row, collection date >= --since, property in --areas):
 *   - Completed                 → inserted terminal (FY usage history).
 *   - Booked, date >= today     → Confirmed — the 15:25 cron advances them and
 *                                 the hourly push EF creates stops. Red Line
 *                                 #5: never set Scheduled here.
 *   - Booked, past-dated        → skipped + reported by default (the MUD table
 *                                 stopped being closed out from Jul 2026, so the
 *                                 outcome is unrecorded). With
 *                                 --past-booked=completed they import as
 *                                 Completed — Dan confirmed 01/09/2026 that all
 *                                 Jul–Aug MUD collections were attended, and FY
 *                                 usage/reporting needs the rows.
 *
 * Match: `MUD Ref (from Address)` → `eligible_properties.mud_code` (exact,
 * unique). The property supplies the area, the strata contact (the CSV has no
 * contact columns) and the waste location, mirroring what
 * create_mud_booking_with_capacity_check derives server-side.
 *
 * Items follow the Verco MUD convention — MUD_UNITS_PER_SERVICE (2) free
 * placeholder units per booked service (src/lib/mud/capacity.ts), NOT the CSV
 * No_Bulk/No_Green count; rows whose CSV count isn't 1 are listed in the
 * report for eyeballing.
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/import-mud-bookings-csv.ts --file="path.csv" --areas=CAM-A,CAM-B,MOS,COT,PEP,VIN           # dry run
 *   npx tsx scripts/import-mud-bookings-csv.ts --file="path.csv" --areas=... --apply                            # write
 *   optional: --since=2026-07-01 (default)  --refs=CAM-MUD-11-2271,... (subset)
 *             --past-booked=completed (past-dated Booked rows → Completed)
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import { normaliseWasteLocation } from './lib/reconcile'
import { pagedIn } from './lib/db'
import { timestamp } from './lib/report'
import { parseCsv, type CsvRow as Row } from './lib/csv'
import { MUD_UNITS_PER_SERVICE } from '../src/lib/mud/capacity'
import { parseDate } from './import-vv-bookings-csv'

// Verge Valet service ids (same client across all VV areas).
const SERVICE = {
  bulk: '756932e9-f6da-40e4-bda3-cd63feba0bd0',
  green: '888fd3d5-64db-43f8-b849-f375796d8610',
} as const

const TODAY = new Date().toISOString().slice(0, 10)

export type Parsed = {
  ref: string
  mudRef: string
  status: string
  date: string | null
  /** Which streams the row books; each becomes one 2-unit placeholder item. */
  services: { service_id: string; csvQty: number }[]
}

function n(s: string | undefined): number {
  const v = Number(s ?? 0)
  return Number.isFinite(v) ? v : 0
}

export function parseRow(r: Row): Parsed {
  const bulk = n(r['No_Bulk']), green = n(r['No_Green'])
  const services: Parsed['services'] = []
  if (bulk > 0) services.push({ service_id: SERVICE.bulk, csvQty: bulk })
  if (green > 0) services.push({ service_id: SERVICE.green, csvQty: green })
  return {
    ref: r['Booking_Ref'] ?? '',
    mudRef: (r['MUD Ref (from Address)'] ?? '').trim(),
    status: r['Status'] ?? '',
    date: parseDate(r['Collection_Date (from Collection_Date)'] ?? ''),
    services,
  }
}

export function targetStatus(status: string, date: string, today = TODAY, pastBooked: 'skip' | 'completed' = 'skip'): 'Completed' | 'Confirmed' | null {
  if (status === 'Completed') return 'Completed'
  if (status === 'Booked') {
    if (date >= today) return 'Confirmed'
    return pastBooked === 'completed' ? 'Completed' : null
  }
  return null
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const file = typeof flags.file === 'string' ? flags.file : null
  const areaCodes = typeof flags.areas === 'string' ? flags.areas.split(',').map((s) => s.trim()).filter(Boolean) : []
  const since = typeof flags.since === 'string' ? flags.since : '2026-07-01'
  const onlyRefs = typeof flags.refs === 'string' ? new Set(flags.refs.split(',').map((s) => s.trim()).filter(Boolean)) : null
  const pastBooked = flags['past-booked'] === 'completed' ? 'completed' as const : 'skip' as const
  if (flags['past-booked'] && flags['past-booked'] !== 'completed') { console.error('--past-booked only accepts "completed"'); process.exit(1) }
  if (!file || areaCodes.length === 0) { console.error('Usage: --file=<csv> --areas=CODE,CODE [--since=YYYY-MM-DD] [--refs=a,b] [--past-booked=completed] [--apply]'); process.exit(1) }
  const unknown = Object.keys(flags).filter((k) => !['apply', 'file', 'areas', 'since', 'refs', 'past-booked'].includes(k))
  if (unknown.length) { console.error(`Unknown flag(s): ${unknown.join(', ')}`); process.exit(1) }

  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  console.log(`Import MUD bookings CSV → ${areaCodes.join(',')}  (${apply ? 'APPLY' : 'DRY RUN'})  today=${TODAY}  since=${since}  past-booked=${pastBooked}`)

  const { data: areas, error: aErr } = await verco.from('collection_area').select('id, client_id, contractor_id, code').in('code', areaCodes)
  if (aErr) throw new Error(aErr.message)
  if (!areas || areas.length !== areaCodes.length) {
    throw new Error(`collection_area lookup: wanted ${areaCodes.length}, found ${areas?.length ?? 0} (${(areas ?? []).map((a) => a.code).join(',')})`)
  }
  const areaById = new Map(areas.map((a) => [a.id as string, a]))
  const areaIds = areas.map((a) => a.id as string)
  const { data: fy } = await verco.from('financial_year').select('id, start_date').eq('is_current', true).single()
  if (!fy) throw new Error('no current financial_year')
  if (since < (fy.start_date as string)) throw new Error(`--since ${since} predates the current FY (${fy.start_date}); rows would be stamped with the wrong fy_id`)

  // Rows
  const all = parseCsv(readFileSync(file, 'utf8')).map(parseRow)
  const inWindow = all.filter((p) => p.date && p.date >= since && (!onlyRefs || onlyRefs.has(p.ref)))
  console.log(`CSV rows: ${all.length}; with collection date >= ${since}: ${inWindow.length}`)

  // Verco state — MUD properties across ALL areas (so a row for a not-yet-live
  // council is reported as inactive_area, not mistaken for a missing property).
  type Prop = {
    id: string; mud_code: string | null; collection_area_id: string | null
    strata_contact_id: string | null; waste_location_notes: string | null
    mud_onboarding_status: string | null; address: string | null
    latitude: number | null; longitude: number | null
  }
  const { data: propRows, error: pErr } = await verco
    .from('eligible_properties')
    .select('id, mud_code, collection_area_id, strata_contact_id, waste_location_notes, mud_onboarding_status, address, latitude, longitude')
    .eq('is_mud', true)
    .not('mud_code', 'is', null)
  if (pErr) throw new Error(pErr.message)
  const propByMud = new Map<string, Prop>()
  const dupMudCodes = new Set<string>()
  for (const p of (propRows ?? []) as Prop[]) {
    const k = p.mud_code!.trim().toUpperCase()
    if (propByMud.has(k)) dupMudCodes.add(k)
    else propByMud.set(k, p)
  }
  console.log(`Verco MUD properties with a mud_code: ${propByMud.size} (${dupMudCodes.size} duplicate codes)`)

  const cdRows = await pagedIn<{ id: string; date: string; collection_area_id: string }>(
    verco, 'collection_date', 'id, date, collection_area_id', 'collection_area_id', areaIds,
  )
  const cdByAreaDate = new Map(cdRows.map((c) => [`${c.collection_area_id}|${c.date}`, c.id]))
  const cdDate = new Map(cdRows.map((c) => [c.id, c.date]))

  const vBookings = await pagedIn<{ id: string; ref: string; property_id: string | null }>(
    verco, 'booking', 'id, ref, property_id', 'collection_area_id', areaIds,
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
  type Plan = { p: Parsed; status: NonNullable<ReturnType<typeof targetStatus>>; prop: Prop; areaCode: string; cdId: string }
  const plans: Plan[] = []
  const skip = {
    past_unresolved: [] as { ref: string; status: string; date: string }[],
    no_mud_ref: [] as string[], no_property: [] as { ref: string; mudRef: string }[],
    ambiguous_mud_code: [] as string[], inactive_area: [] as { ref: string; mudRef: string }[],
    no_contact: [] as { ref: string; mudRef: string }[], no_date: [] as { ref: string; area: string; date: string }[],
    already_in_verco: [] as string[], duplicate_prop_date: [] as string[],
    no_services: [] as string[], unknown_status: [] as { ref: string; status: string }[],
  }
  const seenPropDate = new Map<string, string>()
  const csvDupPairs: { ref: string; twin: string }[] = []
  const nonStandardQty: { ref: string; services: Parsed['services'] }[] = []
  const notRegistered: { ref: string; mudRef: string; status: string }[] = []

  for (const p of inWindow) {
    const date = p.date!
    if (!p.mudRef) { skip.no_mud_ref.push(p.ref); continue }
    const mudKey = p.mudRef.toUpperCase()
    if (dupMudCodes.has(mudKey)) { skip.ambiguous_mud_code.push(p.ref); continue }
    const prop = propByMud.get(mudKey)
    if (!prop) { skip.no_property.push({ ref: p.ref, mudRef: p.mudRef }); continue }
    const area = prop.collection_area_id ? areaById.get(prop.collection_area_id) : undefined
    if (!area) { skip.inactive_area.push({ ref: p.ref, mudRef: p.mudRef }); continue }
    if (p.status !== 'Booked' && p.status !== 'Completed') { skip.unknown_status.push({ ref: p.ref, status: p.status }); continue }
    const status = targetStatus(p.status, date, TODAY, pastBooked)
    if (!status) { skip.past_unresolved.push({ ref: p.ref, status: p.status, date }); continue }
    if (existingRefs.has(p.ref)) { skip.already_in_verco.push(p.ref); continue }
    if (!prop.strata_contact_id) { skip.no_contact.push({ ref: p.ref, mudRef: p.mudRef }); continue }
    const cdId = cdByAreaDate.get(`${prop.collection_area_id}|${date}`)
    if (!cdId) { skip.no_date.push({ ref: p.ref, area: area.code as string, date }); continue }
    if (existingPropDate.has(`${prop.id}|${date}`)) { skip.duplicate_prop_date.push(p.ref); continue }
    if (p.services.length === 0) { skip.no_services.push(p.ref); continue }
    const pd = `${prop.id}|${date}`
    const twin = seenPropDate.get(pd)
    if (twin) { csvDupPairs.push({ ref: p.ref, twin }); continue } // MUDs: one booking per property+date; twin is an Airtable double-entry
    seenPropDate.set(pd, p.ref)
    if (p.services.some((s) => s.csvQty !== 1)) nonStandardQty.push({ ref: p.ref, services: p.services })
    if (prop.mud_onboarding_status !== 'Registered') notRegistered.push({ ref: p.ref, mudRef: p.mudRef, status: prop.mud_onboarding_status ?? 'NULL' })
    plans.push({ p, status, prop, areaCode: area.code as string, cdId })
  }

  const byStatus = plans.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {})
  const byArea = plans.reduce<Record<string, number>>((m, x) => ((m[x.areaCode] = (m[x.areaCode] ?? 0) + 1), m), {})
  const stamp = timestamp()
  const reportPath = `import-mud-report-${stamp}.json`
  writeFileSync(reportPath, JSON.stringify({
    areas: areaCodes, since, today: TODAY, apply, pastBooked,
    plans: plans.map((x) => ({ ref: x.p.ref, status: x.status, date: x.p.date, area: x.areaCode, mudRef: x.p.mudRef, address: x.prop.address, services: x.p.services })),
    csvDupPairs, nonStandardQty, notRegistered, skip,
  }, null, 2))

  console.log('\n═════════ Import plan ═════════')
  console.log(`  would create:                    ${plans.length}   ${JSON.stringify(byStatus)}`)
  console.log(`  by area:                         ${JSON.stringify(byArea)}`)
  console.log(`  MUD not Registered (imported):   ${notRegistered.length} (listed in report)`)
  console.log(`  CSV qty != 1 (2 units anyway):   ${nonStandardQty.length} (listed in report — eyeball them)`)
  console.log(`  skip · same property+date twin   ${csvDupPairs.length}`)
  console.log(`  skip · past, not closed out      ${skip.past_unresolved.length}`)
  console.log(`  skip · already in Verco (ref)    ${skip.already_in_verco.length}`)
  console.log(`  skip · property+date booked      ${skip.duplicate_prop_date.length}`)
  console.log(`  skip · no MUD ref in row         ${skip.no_mud_ref.length}`)
  console.log(`  skip · no property for MUD ref   ${skip.no_property.length}`)
  console.log(`  skip · ambiguous mud_code        ${skip.ambiguous_mud_code.length}`)
  console.log(`  skip · property not in --areas   ${skip.inactive_area.length}`)
  console.log(`  skip · no strata contact         ${skip.no_contact.length}`)
  console.log(`  skip · no collection_date        ${skip.no_date.length}`)
  console.log(`  skip · no services               ${skip.no_services.length}`)
  console.log(`  skip · unknown status            ${skip.unknown_status.length}`)
  console.log(`  report: ${reportPath}`)

  if (!apply) { console.log(`\nDRY RUN — re-run with --apply to create ${plans.length} bookings.`); return }

  let created = 0
  const fail: { ref: string; error: string }[] = []
  for (const pl of plans) {
    const area = areaById.get(pl.prop.collection_area_id!)!
    try {
      const { data: bk, error: bErr } = await verco
        .from('booking')
        .insert({
          ref: pl.p.ref, type: 'MUD', status: pl.status, created_via: 'legacy',
          property_id: pl.prop.id, contact_id: pl.prop.strata_contact_id, collection_area_id: area.id,
          client_id: area.client_id, contractor_id: area.contractor_id, fy_id: fy.id,
          location: normaliseWasteLocation(pl.prop.waste_location_notes ?? ''),
          latitude: pl.prop.latitude, longitude: pl.prop.longitude, geo_address: pl.prop.address,
        })
        .select('id')
        .single()
      if (bErr) throw new Error(bErr.message)
      const rows = pl.p.services.map((s) => ({
        booking_id: bk!.id, service_id: s.service_id, collection_date_id: pl.cdId,
        no_services: MUD_UNITS_PER_SERVICE, unit_price_cents: 0, is_extra: false,
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

const isDirectRun = process.argv[1]?.endsWith('import-mud-bookings-csv.ts')
if (isDirectRun) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
