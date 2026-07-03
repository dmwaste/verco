// scripts/create-missing-kwn-bookings.ts
/**
 * Create the upcoming KWN bookings the legacy import missed.
 *
 * The Kwinana import loaded from the per-area intake tables and missed active
 * bookings that live only in the consolidated master ("Bookings All"). Those are
 * real residents with upcoming collections Verco doesn't know about. This creates
 * them in Verco, replicating the legacy insert shape.
 *
 * Property match: Verco KWN properties carry no Airtable id, and Verco stores the
 * GEOCODED address while the master stores the RAW address, so we match on an
 * address KEY of "<number> <first-street-word> <suburb> <postcode>" (dropping the
 * street type + any directional, which Google rewrites inconsistently). Any key
 * that maps to two DISTINCT Verco addresses is treated as ambiguous and skipped —
 * so the failure mode is a reported miss, never a wrong property.
 *
 * Safe by construction: dry-run default; skips anything it can't fully resolve
 * (no property / ambiguous / no collection_date / no email / would duplicate /
 * past date). Bookings are created Confirmed + created_via='legacy' like the
 * original import; the daily cron advances them to Scheduled.
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/create-missing-kwn-bookings.ts            # dry run
 *   npx tsx scripts/create-missing-kwn-bookings.ts --apply    # create them
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import { normaliseWasteLocation } from './lib/reconcile'

const KWN_BASE = 'apppzIjIc05ghcixH'
const BOOKINGS_ALL = 'tblthTRXTHTvUkxBk'
const KWN_EP_TABLE = 'tbly7Ruw6iOhUo5td'
const KWN_EP_ADDRESS = 'fldadRrqYLFzDLVxK'
const CREATED_SINCE = '2026-04-01'
const TODAY = new Date().toISOString().slice(0, 10)

const F = {
  ref: 'fldfuWaydRMJC4DCW',
  status: 'fld5vEwbAO4aCXmAf',
  property: 'fldNJbqxjmjucNTjJ',
  collectionDate: 'fldIMEWF9CtNlNZ8v',
  wasteLocation: 'fldRb7yyA6ShyYQAw',
  contactName: 'fldLKVNVORKpIajr5',
  contactPhone: 'fldP9XNgSQ5D2ztO8',
  contactEmail: 'fldrAtMBT98EXN1Xw',
  bulk: 'fldeo4w2Wlc0FbM78', // Bulk_Total_All — includes bulk↔green swaps (_Total misses them)
  green: 'fldKbP3n30drkpVq5', // Green_Total_All
  mattress: 'fldgyRXTUmP2PZqEB',
  whitegood: 'fldwZYLFW3l5PUTsa',
  ewaste: 'fldaMIpddbeMYXK81',
  created: 'fldf71ph5Hm5B02lg',
} as const

const SERVICE = {
  bulk: '756932e9-f6da-40e4-bda3-cd63feba0bd0',
  green: '888fd3d5-64db-43f8-b849-f375796d8610',
  mattress: '9a0538d8-111c-452a-9483-3d20b07725a4',
  whitegood: '41042e2d-36ec-40a0-a51e-377c7f536ebc',
  ewaste: '8b9daf58-69b5-41d9-be2b-7e5726998650',
} as const

const ACTIVE = new Set(['Booked', 'Place Out Issued', 'Scheduled'])

/**
 * Robust address key: `<streetNumber> <firstStreetWord> <suburb> <postcode>`.
 * Deliberately drops the street TYPE (Way/St/Pkwy/Loop…) and any directional
 * suffix, because Verco stores the Google-geocoded address (which abbreviates
 * variably and sometimes adds "E"/"S") while the master stores the raw address.
 * A false match would need two different streets to share a first word AND
 * number in the same suburb+postcode — effectively impossible. Returns null if
 * the address can't be parsed (no 4-digit postcode).
 */
function addrKey(a: string): string | null {
  const t = a
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\bWESTERN AUSTRALIA\b/g, 'WA')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
  if (t.length < 4) return null
  const pc = t[t.length - 1]!
  if (!/^\d{4}$/.test(pc)) return null
  let si = t.length - 2
  if (t[si] === 'WA') si-- // token before the state is the suburb
  const suburb = t[si] ?? ''
  return `${t[0]} ${t[1] ?? ''} ${suburb} ${pc}`
}

type Master = {
  ref: string
  epId: string | null
  status: string
  date: string | null
  wasteLocation: string | null
  contactName: string
  contactEmail: string | null
  contactPhone: string | null
  services: { service_id: string; qty: number }[]
}

async function main() {
  const apply = !!parseFlags(process.argv).apply
  const token = requireEnv('AIRTABLE_TOKEN')
  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  console.log(`Create missing KWN bookings  (${apply ? 'APPLY' : 'DRY RUN'})  today=${TODAY}`)

  const { data: cli } = await verco.from('client').select('id, contractor_id').eq('slug', 'kwn').single()
  const clientId = cli!.id as string
  const contractorId = cli!.contractor_id as string
  const { data: areas } = await verco.from('collection_area').select('id, code').like('code', 'KWN%')
  const areaIds = (areas ?? []).map((a) => a.id as string)

  const vBookings = await pagedIn<{ id: string; ref: string; property_id: string | null; fy_id: string }>(
    verco, 'booking', 'id, ref, property_id, fy_id', 'collection_area_id', areaIds,
  )
  const existingRefs = new Set(vBookings.map((b) => b.ref))
  const fyId = mode(vBookings.map((b) => b.fy_id).filter(Boolean))

  // Normalised-address → Verco property (with ambiguity guard).
  const eps = await loadAllKwnProps(verco, areaIds)
  const propByAddr = new Map<string, { id: string; area: string; lat: number | null; lng: number | null; geo: string }>()
  const ambiguous = new Set<string>()
  for (const p of eps) {
    if (!p.address) continue
    const k = addrKey(p.address)
    if (!k) continue
    const prev = propByAddr.get(k)
    if (prev && prev.geo.toUpperCase() !== p.address.toUpperCase()) ambiguous.add(k) // distinct addresses collide → unsafe
    else if (!prev) propByAddr.set(k, { id: p.id, area: p.collection_area_id, lat: p.latitude, lng: p.longitude, geo: p.address })
  }
  console.log(`Verco KWN properties: ${eps.length} (${ambiguous.size} ambiguous normalised addresses)`)

  // Master, then missing (active, upcoming, not in Verco).
  const master = await fetchMaster(token)
  const missing = master.filter((m) => ACTIVE.has(m.status) && m.date && m.date >= TODAY && !existingRefs.has(m.ref))
  console.log(`Master rows: ${master.length}; missing (active, upcoming, not in Verco): ${missing.length}`)

  // Resolve missing EP-ids → raw Kwinana address.
  const epIds = uniq(missing.map((m) => m.epId).filter((x): x is string => !!x))
  const epAddr = await fetchKwnEpAddresses(token, epIds)

  // collection_date (area|date → id) + existing (property|date) for de-dup.
  const cdRows = await pagedIn<{ id: string; date: string; collection_area_id: string }>(
    verco, 'collection_date', 'id, date, collection_area_id', 'collection_area_id', areaIds,
  )
  const cdByAreaDate = new Map(cdRows.map((c) => [`${c.collection_area_id}|${c.date}`, c.id]))
  const cdDate = new Map(cdRows.map((c) => [c.id, c.date]))
  const bItems = await pagedIn<{ booking_id: string; collection_date_id: string | null }>(
    verco, 'booking_item', 'booking_id, collection_date_id', 'booking_id', vBookings.map((b) => b.id),
  )
  const bookingProp = new Map(vBookings.map((b) => [b.id, b.property_id]))
  const existingPropDate = new Set<string>()
  for (const it of bItems) {
    const p = bookingProp.get(it.booking_id)
    const d = it.collection_date_id ? cdDate.get(it.collection_date_id) : null
    if (p && d) existingPropDate.add(`${p}|${d}`)
  }

  type Plan = { m: Master; propertyId: string; areaId: string; cdId: string; loc: string; lat: number | null; lng: number | null; geo: string }
  const plans: Plan[] = []
  const skip = { no_property: [] as string[], ambiguous: [] as string[], no_date: [] as string[], duplicate: [] as string[], no_email: [] as string[], no_services: [] as string[] }
  const noPropDiag: { ref: string; raw: string; key: string }[] = []

  for (const m of missing) {
    const raw = m.epId ? epAddr.get(m.epId) : undefined
    const key = raw ? addrKey(raw) : null
    if (key && ambiguous.has(key)) { skip.ambiguous.push(m.ref); continue }
    const p = key ? propByAddr.get(key) : undefined
    if (!p) { skip.no_property.push(m.ref); noPropDiag.push({ ref: m.ref, raw: raw ?? '(no EP address)', key: key ?? '(unparseable)' }); continue }
    const cdId = cdByAreaDate.get(`${p.area}|${m.date}`)
    if (!cdId) { skip.no_date.push(m.ref); continue }
    if (existingPropDate.has(`${p.id}|${m.date}`)) { skip.duplicate.push(m.ref); continue }
    if (m.services.length === 0) { skip.no_services.push(m.ref); continue }
    if (!m.contactEmail) { skip.no_email.push(m.ref); continue }
    plans.push({ m, propertyId: p.id, areaId: p.area, cdId, loc: m.wasteLocation ? normaliseWasteLocation(m.wasteLocation) : '', lat: p.lat, lng: p.lng, geo: p.geo })
  }

  const stamp = timestamp()
  writeFileSync(`create-missing-kwn-report-${stamp}.json`, JSON.stringify({ plans: plans.map((p) => ({ ref: p.m.ref, date: p.m.date, loc: p.loc, services: p.m.services })), skip, noPropDiag }, null, 2))
  console.log('\n═════════ Create plan ═════════')
  console.log(`  would create:              ${plans.length}`)
  console.log(`  skip · no property match   ${skip.no_property.length}`)
  console.log(`  skip · ambiguous address   ${skip.ambiguous.length}`)
  console.log(`  skip · no collection_date  ${skip.no_date.length}`)
  console.log(`  skip · already booked      ${skip.duplicate.length}`)
  console.log(`  skip · no email            ${skip.no_email.length}`)
  console.log(`  skip · no services         ${skip.no_services.length}`)

  if (!apply) {
    console.log(`\nDRY RUN — re-run with --apply to create ${plans.length} bookings. Report: create-missing-kwn-report-${stamp}.json`)
    return
  }

  let created = 0
  const fail: { ref: string; error: string }[] = []
  for (const pl of plans) {
    try {
      const contactId = await upsertContact(verco, pl.m)
      const { data: bk, error: bErr } = await verco
        .from('booking')
        .insert({
          ref: pl.m.ref, type: 'Residential', status: 'Confirmed', created_via: 'legacy',
          property_id: pl.propertyId, contact_id: contactId, collection_area_id: pl.areaId,
          client_id: clientId, contractor_id: contractorId, fy_id: fyId, location: pl.loc,
          latitude: pl.lat, longitude: pl.lng, geo_address: pl.geo,
          notes: 'Created by reconciliation — missing from the KWN legacy import.',
        })
        .select('id')
        .single()
      if (bErr) throw new Error(bErr.message)
      const rows = pl.m.services.map((s) => ({
        booking_id: bk!.id, service_id: s.service_id, collection_date_id: pl.cdId,
        no_services: s.qty, unit_price_cents: 0, is_extra: false,
      }))
      const { error: iErr } = await verco.from('booking_item').insert(rows)
      if (iErr) throw new Error(`items: ${iErr.message}`)
      created++
    } catch (e) {
      fail.push({ ref: pl.m.ref, error: (e as Error).message })
    }
  }
  console.log(`\nCreated ${created}/${plans.length} bookings.`)
  for (const f of fail) console.error(`  ✗ ${f.ref}: ${f.error}`)
}

async function upsertContact(verco: SupabaseClient, m: Master): Promise<string> {
  const email = m.contactEmail!.trim().toLowerCase()
  const { data: existing } = await verco.from('contacts').select('id').eq('email', email).limit(1).maybeSingle()
  if (existing) return existing.id as string
  const name = (m.contactName || '').trim()
  const sp = name.indexOf(' ')
  const first = sp > 0 ? name.slice(0, sp) : name || 'Resident'
  const last = sp > 0 ? name.slice(sp + 1) : '—'
  const { data, error } = await verco.from('contacts').insert({ first_name: first, last_name: last, email, mobile_e164: m.contactPhone || null }).select('id').single()
  if (error) throw new Error(`contact: ${error.message}`)
  return data!.id as string
}

async function loadAllKwnProps(verco: SupabaseClient, areaIds: string[]) {
  const out: { id: string; address: string | null; latitude: number | null; longitude: number | null; collection_area_id: string }[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await verco
      .from('eligible_properties')
      .select('id, address, latitude, longitude, collection_area_id')
      .in('collection_area_id', areaIds)
      .order('id', { ascending: true }) // stable order — range() pagination skips/dupes rows without it
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load props: ${error.message}`)
    if (!data || data.length === 0) break
    out.push(...(data as typeof out))
    if (data.length < PAGE) break
    from += PAGE
  }
  return out
}

async function fetchKwnEpAddresses(token: string, epIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (let i = 0; i < epIds.length; i += 40) {
    const chunk = epIds.slice(i, i + 40)
    const formula = `OR(${chunk.map((id) => `RECORD_ID()='${id}'`).join(',')})`
    const params = new URLSearchParams({ pageSize: '100', filterByFormula: formula })
    params.append('fields[]', KWN_EP_ADDRESS)
    const res = await fetch(`https://api.airtable.com/v0/${KWN_BASE}/${KWN_EP_TABLE}?${params}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Airtable EP HTTP ${res.status}`)
    const body = (await res.json()) as { records: Array<{ id: string; fields: Record<string, unknown> }> }
    for (const rec of body.records) {
      const addr = rec.fields[KWN_EP_ADDRESS] ?? rec.fields['Address']
      if (typeof addr === 'string') map.set(rec.id, addr)
    }
  }
  return map
}

async function fetchMaster(token: string): Promise<Master[]> {
  const out: Master[] = []
  let offset: string | undefined
  const formula = `IS_AFTER({Created}, "${CREATED_SINCE}")`
  do {
    const params = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true', filterByFormula: formula })
    for (const id of Object.values(F)) params.append('fields[]', id)
    if (offset) params.set('offset', offset)
    const res = await fetch(`https://api.airtable.com/v0/${KWN_BASE}/${BOOKINGS_ALL}?${params}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Airtable HTTP ${res.status}`)
    const body = (await res.json()) as { records: Array<{ fields: Record<string, unknown> }>; offset?: string }
    for (const rec of body.records) {
      const f = rec.fields
      const ref = f[F.ref] as string | undefined
      const status = f[F.status] as string | undefined
      if (!ref || !status) continue
      const services: Master['services'] = []
      const push = (id: string, v: unknown) => { const n = typeof v === 'number' ? v : 0; if (n > 0) services.push({ service_id: id, qty: n }) }
      push(SERVICE.bulk, f[F.bulk]); push(SERVICE.green, f[F.green]); push(SERVICE.mattress, f[F.mattress]); push(SERVICE.whitegood, f[F.whitegood]); push(SERVICE.ewaste, f[F.ewaste])
      out.push({
        ref: String(ref), epId: (f[F.property] as string[] | undefined)?.[0] ?? null, status,
        date: (f[F.collectionDate] as string[] | undefined)?.[0] ?? null,
        wasteLocation: (f[F.wasteLocation] as string | undefined) ?? null,
        contactName: (f[F.contactName] as string | undefined) ?? '',
        contactEmail: (f[F.contactEmail] as string | undefined) ?? null,
        contactPhone: (f[F.contactPhone] as string | undefined) ?? null,
        services,
      })
    }
    offset = body.offset
  } while (offset)
  return out
}

async function pagedIn<T>(verco: SupabaseClient, table: string, select: string, column: string, values: string[]): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < values.length; i += 100) {
    const chunk = values.slice(i, i + 100)
    if (!chunk.length) continue
    const { data, error } = await verco.from(table).select(select).in(column, chunk)
    if (error) throw new Error(`load ${table}: ${error.message}`)
    out.push(...((data ?? []) as T[]))
  }
  return out
}

const uniq = (xs: string[]) => [...new Set(xs)]
function mode(xs: string[]): string {
  const c = new Map<string, number>()
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1)
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}
function timestamp(): string {
  const d = new Date()
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1) })
