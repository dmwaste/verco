// scripts/fix-kwn-location.ts
/**
 * Fix Kwinana (KWN) legacy bookings whose `location` was imported as the street
 * address instead of the verge placement (Front Verge / Side Verge / …).
 *
 * Unlike the VV councils, KWN eligible_properties carry no Airtable record id, so
 * the bridge here is the **exact booking reference**: Verco `booking.ref`
 * ("KWN-22872") == the Airtable `Bookings All`.Booking_Ref. We read the correct
 * `Waste_Location` from that master, normalise it to Verco's short form, and set
 * `booking.location`.
 *
 * Only touches bookings whose location still looks like an address (starts with a
 * digit) — resident/admin bookings that already hold a verge value are left alone.
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/fix-kwn-location.ts            # dry run (default)
 *   npx tsx scripts/fix-kwn-location.ts --apply    # write the fixes
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseFlags, requireEnv } from './lib/cli'
import { normaliseWasteLocation } from './lib/reconcile'

const KWN_BASE = 'apppzIjIc05ghcixH' // "Kwinana Pre-booked Verge Collection"
const BOOKINGS_ALL = 'tblthTRXTHTvUkxBk' // consolidated master
const F = { ref: 'fldfuWaydRMJC4DCW', wasteLocation: 'fldRb7yyA6ShyYQAw' }
const ADDRESSISH = /^\s*\d/ // a location that starts with a digit is a street address

async function main() {
  const apply = !!parseFlags(process.argv).apply
  const airtableToken = requireEnv('AIRTABLE_TOKEN')
  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))

  console.log(`Fix KWN booking locations  (${apply ? 'APPLY' : 'DRY RUN'})`)

  // 1. Build Booking_Ref → normalised Waste_Location from the Kwinana master.
  const refToLocation = await fetchRefToLocation(airtableToken)
  console.log(`Airtable "Bookings All": ${refToLocation.size} refs with a Waste_Location.`)

  // 2. Load KWN bookings whose location is still an address.
  const wrong = await loadKwnAddressBookings(verco)
  console.log(`Verco: ${wrong.length} KWN bookings with an address in the location field.`)

  // 3. Resolve each against the master; group by target value for batch updates.
  const byTarget = new Map<string, string[]>() // normalised location → booking ids
  const unmatched: string[] = []
  const noSource: string[] = []
  for (const b of wrong) {
    const target = refToLocation.get(b.ref)
    if (target === undefined) {
      // ref not present in master, or the master row had no Waste_Location
      ;(refToLocation.has(b.ref) ? noSource : unmatched).push(b.ref)
      continue
    }
    ;(byTarget.get(target) ?? byTarget.set(target, []).get(target)!).push(b.id)
  }

  const fixable = [...byTarget.values()].reduce((n, ids) => n + ids.length, 0)
  console.log('\n─ plan ─')
  for (const [loc, ids] of [...byTarget].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(ids.length).padStart(4)}  → ${loc}`)
  }
  console.log(`  ${String(unmatched.length).padStart(4)}  ref not found in master (skipped)`)
  console.log(`  ${String(noSource.length).padStart(4)}  master row has no Waste_Location (skipped)`)
  console.log(`  total fixable: ${fixable} / ${wrong.length}`)

  // 4. Apply — one UPDATE per distinct location value.
  if (!apply) {
    console.log('\nDRY RUN — re-run with --apply to write the fixes.')
    return
  }
  let fixed = 0
  for (const [loc, ids] of byTarget) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { error } = await verco.from('booking').update({ location: loc }).in('id', chunk)
      if (error) console.error(`  ✗ "${loc}" batch: ${error.message}`)
      else fixed += chunk.length
    }
  }
  console.log(`\nApplied: set location on ${fixed} booking(s).`)
}

async function fetchRefToLocation(token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let offset: string | undefined
  do {
    const params = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' })
    params.append('fields[]', F.ref)
    params.append('fields[]', F.wasteLocation)
    if (offset) params.set('offset', offset)
    const url = `https://api.airtable.com/v0/${KWN_BASE}/${BOOKINGS_ALL}?${params}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Airtable HTTP ${res.status}`)
    const body = (await res.json()) as { records: Array<{ fields: Record<string, unknown> }>; offset?: string }
    for (const rec of body.records) {
      const ref = rec.fields[F.ref]
      const wl = rec.fields[F.wasteLocation]
      if (ref && typeof wl === 'string' && wl) map.set(String(ref), normaliseWasteLocation(wl))
    }
    offset = body.offset
  } while (offset)
  return map
}

async function loadKwnAddressBookings(verco: SupabaseClient): Promise<Array<{ id: string; ref: string }>> {
  const { data: areas, error: aErr } = await verco.from('collection_area').select('id, code').like('code', 'KWN%')
  if (aErr) throw new Error(`load KWN areas: ${aErr.message}`)
  const areaIds = (areas ?? []).map((a) => a.id)

  const out: Array<{ id: string; ref: string }> = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await verco
      .from('booking')
      .select('id, ref, location')
      .in('collection_area_id', areaIds)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load KWN bookings: ${error.message}`)
    if (!data || data.length === 0) break
    for (const b of data) if (typeof b.location === 'string' && ADDRESSISH.test(b.location)) out.push({ id: b.id, ref: b.ref })
    if (data.length < PAGE) break
    from += PAGE
  }
  return out
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
