// scripts/import-kwn-mud-bookings.ts
/**
 * Import Kwinana MUD bookings from the KWN Airtable base's `MUD Bookings`
 * table into Verco.
 *
 * Why: KWN went live on Verco on 6 July 2026 but there was never an import for
 * its MUD bookings — the residential masters came across via
 * import-kwn-bookings-csv.ts and the MUD *properties* via
 * import-kwn-mud-properties.ts, while the MUD *bookings* were re-keyed by hand
 * through the admin on-behalf flow. That pass missed 18 properties (45 future
 * Airtable rows, 13 of them on Mon 2 Nov 2026 — the Orelia KWN-MDD-15..25 run
 * plus KWN-MDD-59/67). This is the VV MUD importer (import-mud-bookings-csv.ts)
 * pointed at the KWN base, reading Airtable directly instead of a CSV.
 *
 * Same status rules as the VV importer (targetStatus is shared):
 *   - Completed                 → inserted terminal (FY usage history).
 *   - Booked, date >= today     → Confirmed — the 15:25 cron advances them and
 *                                 the hourly push EF creates stops. Red Line
 *                                 #5: never set Scheduled here.
 *   - Booked, past-dated        → skipped + reported (outcome unrecorded);
 *                                 --past-booked=completed imports as Completed.
 *   - Booked, before --live-from → skipped + reported.
 *
 * Match: the row's linked `Address` record → `eligible_properties.external_id`
 * (external_source = 'airtable-mud-kwn', stamped by the property import).
 * That is exact and unique; mud_code is NOT used because KWN-MDD-56 exists
 * twice (Medina KWN-1 + Wellard KWN-3). The property supplies the area, the
 * strata contact and the waste location, mirroring
 * create_mud_booking_with_capacity_check.
 *
 * Items follow the Verco MUD convention — MUD_UNITS_PER_SERVICE (2) free
 * placeholder units per booked stream, not the Airtable No_Bulk/No_Green count.
 *
 * Registered gate: the admin RPC refuses MUDs that aren't `Registered`. This
 * importer mirrors the VV one — it imports regardless and LISTS the
 * not-Registered rows — unless --registered-only is passed. Capacity: inserts
 * are direct (legacy pattern; the booking_item counter trigger keeps
 * collection_date.*_units_booked honest) so the plan prints a per-date
 * capacity impact and flags any date the import would push past its limit.
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/import-kwn-mud-bookings.ts                      # dry run
 *   npx tsx scripts/import-kwn-mud-bookings.ts --apply              # write
 *   optional: --since=2026-07-01 (default)  --refs=KWN-MDD-15-1312,... (subset)
 *             --registered-only             (skip MUDs not yet Registered)
 *             --past-booked=completed       (past-dated Booked rows → Completed)
 *             --live-from=YYYY-MM-DD        (first date Verco dispatches; default today AWST)
 */
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import { normaliseWasteLocation } from './lib/reconcile'
import { pagedIn } from './lib/db'
import { timestamp } from './lib/report'
import { airtableFetch, KWN_BASE_ID } from './lib/airtable-mud'
import { MUD_UNITS_PER_SERVICE } from '../src/lib/mud/capacity'
import { TODAY } from './import-vv-bookings-csv'
import { targetStatus } from './import-mud-bookings-csv'

// Services are global (not per client) — the same Bulk/Green ids the VV
// importer uses, confirmed against KWN-1 service_rules 14/10/2026.
const SERVICE = {
  bulk: '756932e9-f6da-40e4-bda3-cd63feba0bd0',
  green: '888fd3d5-64db-43f8-b849-f375796d8610',
} as const
const AREA_CODES = ['KWN-1', 'KWN-2', 'KWN-3', 'KWN-4']
const EXTERNAL_SOURCE = 'airtable-mud-kwn'

// KWN base, table "MUD Bookings" (tblSi36edL3iKJgmC). Field ids:
const MUD_BOOKINGS_TABLE_ID = 'tblSi36edL3iKJgmC'
export const F = {
  ref: 'fldNUOrWU0A2AGLOM',      // Booking_Ref (formula)                 e.g. KWN-MDD-15-1312
  status: 'fldNkRg65bYaBHG87',   // Status (singleSelect → plain string)  Booked / Cancelled / (empty)
  addressLink: 'fldGjgDpoXDawmEvV', // Address (link → MUD List record ids)
  address: 'fld6ti2hWAiYgoKLF',  // Address (from Address) lookup → string[]
  date: 'fldSxGxfdZZsORO48',     // Collection Date lookup → ["YYYY-MM-DD"]
  mudRef: 'fldiAyiLIAE2Ea3bX',   // MUD Ref (from Address) lookup → string[]
  bulk: 'fldURyaXmA51jyVNu',     // No_Bulk
  green: 'fldMMFxN1iFVf3ccT',    // No_Green
} as const

export type MudBookingFields = {
  [F.ref]?: string
  [F.status]?: string
  [F.addressLink]?: string[]
  [F.address]?: string[]
  [F.date]?: string[]
  [F.mudRef]?: string[]
  [F.bulk]?: number
  [F.green]?: number
}
export type AirtableRecord = { id: string; createdTime: string; fields: MudBookingFields }

export type Parsed = {
  airtableId: string
  ref: string
  status: string
  /** Linked MUD List record id — the property bridge (eligible_properties.external_id). */
  addressRecId: string | null
  address: string
  mudRef: string
  date: string | null
  services: { service_id: string; csvQty: number }[]
}

function n(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Refs of rows collected outside the FY every row is stamped with. Allocations
 * count against the collection's FY, but some councils let a June booking for
 * July use the booked FY (Dan, 18/10/2026), so the importer never picks one: it
 * stops and a person decides.
 */
export function refsOutsideFy(
  rows: { ref: string; date: string | null }[],
  fy: { start_date: string; end_date: string },
): string[] {
  return rows.filter((p) => p.date && (p.date < fy.start_date || p.date > fy.end_date)).map((p) => p.ref)
}

export function parseRecord(r: AirtableRecord): Parsed {
  const f = r.fields
  const bulk = n(f[F.bulk]), green = n(f[F.green])
  const services: Parsed['services'] = []
  if (bulk > 0) services.push({ service_id: SERVICE.bulk, csvQty: bulk })
  if (green > 0) services.push({ service_id: SERVICE.green, csvQty: green })
  const date = f[F.date]?.[0] ?? null
  return {
    airtableId: r.id,
    ref: (f[F.ref] ?? '').trim(),
    status: (f[F.status] ?? '').trim(),
    addressRecId: f[F.addressLink]?.[0] ?? null,
    address: (f[F.address]?.[0] ?? '').trim(),
    mudRef: (f[F.mudRef]?.[0] ?? '').trim(),
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    services,
  }
}

/**
 * Per-date capacity impact of a plan: units the import adds vs the bulk-
 * category room left. `over` lists the dates that would end past their limit
 * (MUD bulk + green both count against the `bulk` category bucket).
 */
export function capacityImpact(
  plans: { cdId: string; units: number }[],
  dates: Map<string, { code: string; date: string; limit: number; booked: number }>,
): { rows: { cdId: string; code: string; date: string; limit: number; booked: number; adding: number; after: number }[]; over: string[] } {
  const adding = new Map<string, number>()
  for (const p of plans) adding.set(p.cdId, (adding.get(p.cdId) ?? 0) + p.units)
  const rows = [...adding.entries()].map(([cdId, add]) => {
    const d = dates.get(cdId)!
    return { cdId, code: d.code, date: d.date, limit: d.limit, booked: d.booked, adding: add, after: d.booked + add }
  }).sort((a, b) => a.code.localeCompare(b.code) || a.date.localeCompare(b.date))
  return { rows, over: rows.filter((r) => r.after > r.limit).map((r) => `${r.code} ${r.date}`) }
}

async function fetchAllMudBookings(token: string): Promise<AirtableRecord[]> {
  const out: AirtableRecord[] = []
  let offset: string | undefined
  do {
    const params = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' })
    for (const id of Object.values(F)) params.append('fields[]', id)
    if (offset) params.set('offset', offset)
    const body = await airtableFetch<{ records: AirtableRecord[]; offset?: string }>(
      `https://api.airtable.com/v0/${KWN_BASE_ID}/${MUD_BOOKINGS_TABLE_ID}?${params}`, token,
    )
    out.push(...body.records)
    offset = body.offset
  } while (offset)
  return out
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const since = typeof flags.since === 'string' ? flags.since : '2026-07-01'
  const onlyRefs = typeof flags.refs === 'string' ? new Set(flags.refs.split(',').map((s) => s.trim()).filter(Boolean)) : null
  const registeredOnly = !!flags['registered-only']
  const pastBooked = flags['past-booked'] === 'completed' ? 'completed' as const : 'skip' as const
  const liveFrom = typeof flags['live-from'] === 'string' ? flags['live-from'] : TODAY
  if (flags['past-booked'] && flags['past-booked'] !== 'completed') { console.error('--past-booked only accepts "completed"'); process.exit(1) }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(liveFrom)) { console.error(`--live-from must be YYYY-MM-DD, got "${liveFrom}"`); process.exit(1) }
  const unknown = Object.keys(flags).filter((k) => !['apply', 'since', 'refs', 'registered-only', 'past-booked', 'live-from'].includes(k))
  if (unknown.length) { console.error(`Unknown flag(s): ${unknown.join(', ')}`); process.exit(1) }

  const token = requireEnv('AIRTABLE_TOKEN')
  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  console.log(`Import KWN MUD bookings (Airtable → Verco)  (${apply ? 'APPLY' : 'DRY RUN'})  today=${TODAY} (AWST)  since=${since}  live-from=${liveFrom}  past-booked=${pastBooked}  registered-only=${registeredOnly}`)

  const { data: areas, error: aErr } = await verco.from('collection_area').select('id, client_id, contractor_id, code').in('code', AREA_CODES)
  if (aErr) throw new Error(aErr.message)
  if (!areas || areas.length !== AREA_CODES.length) throw new Error(`collection_area lookup: wanted ${AREA_CODES.length}, found ${areas?.length ?? 0}`)
  const areaById = new Map(areas.map((a) => [a.id as string, a]))
  const areaIds = areas.map((a) => a.id as string)
  const { data: fy } = await verco.from('financial_year').select('id, start_date, end_date').eq('is_current', true).single()
  if (!fy) throw new Error('no current financial_year')
  if (since < (fy.start_date as string)) throw new Error(`--since ${since} predates the current FY (${fy.start_date}); rows would be stamped with the wrong fy_id`)

  // Airtable rows
  const all = (await fetchAllMudBookings(token)).map(parseRecord)
  const undated = all.filter((p) => !p.date)
  if (all.length > 0 && undated.length === all.length) throw new Error('no Airtable row has a parseable Collection Date — check the lookup field id')
  const inWindow = all.filter((p) => p.date && p.date >= since && (!onlyRefs || onlyRefs.has(p.ref)))
  console.log(`Airtable rows: ${all.length}; no collection date: ${undated.length}; with collection date >= ${since}: ${inWindow.length}`)
  const outsideFy = refsOutsideFy(inWindow, { start_date: fy.start_date as string, end_date: fy.end_date as string })
  if (outsideFy.length > 0) {
    throw new Error(
      `${outsideFy.length} row(s) are collected outside the current FY (${fy.start_date}–${fy.end_date}) and would be stamped with the wrong fy_id: ${outsideFy.join(', ')}. ` +
        'Decide their FY (collection FY, or the booked FY for councils that allow it), then exclude them with --refs or import them separately.',
    )
  }

  // Verco state
  type Prop = {
    id: string; external_id: string | null; mud_code: string | null; collection_area_id: string | null
    strata_contact_id: string | null; waste_location_notes: string | null
    mud_onboarding_status: string | null; address: string | null
    latitude: number | null; longitude: number | null
  }
  const { data: propRows, error: pErr } = await verco
    .from('eligible_properties')
    .select('id, external_id, mud_code, collection_area_id, strata_contact_id, waste_location_notes, mud_onboarding_status, address, latitude, longitude')
    .eq('is_mud', true)
    .eq('external_source', EXTERNAL_SOURCE)
  if (pErr) throw new Error(pErr.message)
  const propByRec = new Map<string, Prop>()
  for (const p of (propRows ?? []) as Prop[]) if (p.external_id) propByRec.set(p.external_id, p)
  console.log(`Verco KWN MUD properties from Airtable: ${propByRec.size}`)

  type CdRow = { id: string; date: string; collection_area_id: string; bulk_capacity_limit: number; bulk_units_booked: number }
  const cdRows = await pagedIn<CdRow>(verco, 'collection_date', 'id, date, collection_area_id, bulk_capacity_limit, bulk_units_booked', 'collection_area_id', areaIds)
  const cdByAreaDate = new Map(cdRows.map((c) => [`${c.collection_area_id}|${c.date}`, c.id]))
  const cdDate = new Map(cdRows.map((c) => [c.id, c.date]))
  const cdInfo = new Map(cdRows.map((c) => [c.id, { code: areaById.get(c.collection_area_id)?.code as string, date: c.date, limit: c.bulk_capacity_limit, booked: c.bulk_units_booked }]))

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

  // Plan
  type Plan = { p: Parsed; status: NonNullable<ReturnType<typeof targetStatus>>; prop: Prop; areaCode: string; cdId: string }
  const plans: Plan[] = []
  const skip = {
    past_unresolved: [] as { ref: string; status: string; date: string }[],
    before_live_from: [] as { ref: string; status: string; date: string }[],
    no_address_link: [] as string[], no_property: [] as { ref: string; mudRef: string; address: string }[],
    no_contact: [] as { ref: string; mudRef: string }[], no_date: [] as { ref: string; area: string; date: string }[],
    already_in_verco: [] as string[], duplicate_prop_date: [] as string[],
    no_services: [] as string[], unknown_status: [] as { ref: string; status: string }[],
    not_registered: [] as { ref: string; mudRef: string; status: string }[],
  }
  const seenPropDate = new Map<string, string>()
  const airtableDupPairs: { ref: string; twin: string }[] = []
  const nonStandardQty: { ref: string; services: Parsed['services'] }[] = []
  const notRegistered: { ref: string; mudRef: string; status: string }[] = []

  for (const p of inWindow) {
    const date = p.date!
    if (!p.addressRecId) { skip.no_address_link.push(p.ref); continue }
    const prop = propByRec.get(p.addressRecId)
    if (!prop) { skip.no_property.push({ ref: p.ref, mudRef: p.mudRef, address: p.address }); continue }
    const area = prop.collection_area_id ? areaById.get(prop.collection_area_id) : undefined
    if (!area) { skip.no_property.push({ ref: p.ref, mudRef: p.mudRef, address: p.address }); continue }
    if (p.status !== 'Booked' && p.status !== 'Completed') { skip.unknown_status.push({ ref: p.ref, status: p.status || '(blank)' }); continue }
    const status = targetStatus(p.status, date, TODAY, pastBooked, liveFrom)
    if (!status) {
      const bucket = targetStatus(p.status, date, TODAY, pastBooked) ? skip.before_live_from : skip.past_unresolved
      bucket.push({ ref: p.ref, status: p.status, date })
      continue
    }
    if (existingRefs.has(p.ref)) { skip.already_in_verco.push(p.ref); continue }
    if (!prop.strata_contact_id) { skip.no_contact.push({ ref: p.ref, mudRef: p.mudRef }); continue }
    const cdId = cdByAreaDate.get(`${prop.collection_area_id}|${date}`)
    if (!cdId) { skip.no_date.push({ ref: p.ref, area: area.code as string, date }); continue }
    if (existingPropDate.has(`${prop.id}|${date}`)) { skip.duplicate_prop_date.push(p.ref); continue }
    if (p.services.length === 0) { skip.no_services.push(p.ref); continue }
    const pd = `${prop.id}|${date}`
    const twin = seenPropDate.get(pd)
    if (twin) { airtableDupPairs.push({ ref: p.ref, twin }); continue } // one booking per property+date; twin is an Airtable double-entry
    seenPropDate.set(pd, p.ref)
    if (p.services.some((s) => s.csvQty !== 1)) nonStandardQty.push({ ref: p.ref, services: p.services })
    if (prop.mud_onboarding_status !== 'Registered') {
      const row = { ref: p.ref, mudRef: p.mudRef, status: prop.mud_onboarding_status ?? 'NULL' }
      if (registeredOnly) { skip.not_registered.push(row); continue }
      notRegistered.push(row)
    }
    plans.push({ p, status, prop, areaCode: area.code as string, cdId })
  }

  const byStatus = plans.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {})
  const byArea = plans.reduce<Record<string, number>>((m, x) => ((m[x.areaCode] = (m[x.areaCode] ?? 0) + 1), m), {})
  // Only future (Confirmed) rows change capacity; terminal history rows land on past dates.
  const capacity = capacityImpact(
    plans.filter((x) => x.status === 'Confirmed').map((x) => ({ cdId: x.cdId, units: x.p.services.length * MUD_UNITS_PER_SERVICE })),
    cdInfo,
  )
  const stamp = timestamp()
  const reportPath = `import-kwn-mud-report-${stamp}.json`
  writeFileSync(reportPath, JSON.stringify({
    since, liveFrom, today: TODAY, apply, pastBooked, registeredOnly,
    plans: plans.map((x) => ({ ref: x.p.ref, status: x.status, date: x.p.date, area: x.areaCode, mudRef: x.p.mudRef, address: x.prop.address, onboarding: x.prop.mud_onboarding_status, services: x.p.services })),
    capacity, airtableDupPairs, nonStandardQty, notRegistered, undated: undated.map((p) => ({ ref: p.ref, status: p.status })), skip,
  }, null, 2))

  console.log('\n═════════ Import plan ═════════')
  console.log(`  would create:                    ${plans.length}   ${JSON.stringify(byStatus)}`)
  console.log(`  by area:                         ${JSON.stringify(byArea)}`)
  console.log(`  MUD not Registered (imported):   ${notRegistered.length} (listed in report)`)
  console.log(`  Airtable qty != 1 (2 units anyway): ${nonStandardQty.length} (listed in report — eyeball them)`)
  console.log(`  skip · not Registered (--registered-only) ${skip.not_registered.length}`)
  console.log(`  skip · same property+date twin   ${airtableDupPairs.length}`)
  console.log(`  skip · past, not closed out      ${skip.past_unresolved.length}`)
  console.log(`  skip · before --live-from        ${skip.before_live_from.length}`)
  console.log(`  skip · already in Verco (ref)    ${skip.already_in_verco.length}`)
  console.log(`  skip · property+date booked      ${skip.duplicate_prop_date.length}`)
  console.log(`  skip · no Address link in row    ${skip.no_address_link.length}`)
  console.log(`  skip · no Verco property         ${skip.no_property.length}`)
  console.log(`  skip · no strata contact         ${skip.no_contact.length}`)
  console.log(`  skip · no collection_date        ${skip.no_date.length}`)
  console.log(`  skip · no services               ${skip.no_services.length}`)
  console.log(`  skip · status not Booked/Completed ${skip.unknown_status.length}`)
  console.log('\n  capacity (bulk category, units):')
  for (const r of capacity.rows) console.log(`    ${r.code} ${r.date}: ${r.booked}/${r.limit} booked, +${r.adding} → ${r.after}${r.after > r.limit ? '  ⚠ OVER LIMIT' : ''}`)
  if (capacity.over.length) console.log(`  ⚠ ${capacity.over.length} date(s) would exceed their bulk limit: ${capacity.over.join(', ')}`)
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

const isDirectRun = process.argv[1]?.endsWith('import-kwn-mud-bookings.ts')
if (isDirectRun) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
