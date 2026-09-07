// scripts/add-missing-vv-muds.ts
/**
 * One-off (01/09/2026): create the 5 MUD properties that exist in the Airtable
 * `MUD List` (base appWSysd50QoVaaRD) but were missing from Verco — they were
 * added to Airtable after the May MUD property import, so the MUD bookings
 * import (import-mud-bookings-csv.ts) had no property to attach 8 bookings to.
 *
 * Data was pulled live from the MUD List via the Airtable MCP; the REAL
 * Airtable record ids go in (external_source='airtable-mud', external_id) so a
 * future import-mud-properties.ts re-run upserts onto these rows instead of
 * duplicating them. Status stays 'Contact Made' — Registered requires
 * auth_form_url (constraint), and forms come via a proper
 * import-mud-properties run, which will also promote data-complete rows.
 *
 * VIN-MUD-105 wrinkle: Airtable rec333qshcCKorNSD used to be the VIN-MUD-10
 * "46-56 Smith ST" record (that's what the May import stored), but WMRC later
 * split/renamed it — Airtable now has recC6K9FvqW16XcJF = VIN-MUD-10 and
 * rec333qshcCKorNSD = VIN-MUD-105 "46 Smith St", both with live bookings. The
 * existing Verco row kept its VIN-MUD-10 content but the stale external_id, so
 * before re-running this script we repointed it (01/09/2026, prod SQL):
 *   UPDATE eligible_properties SET external_id = 'recC6K9FvqW16XcJF'
 *   WHERE id = '03826373-5623-4bd6-93e8-63b3c3a21541'
 *     AND external_id = 'rec333qshcCKorNSD';
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/add-missing-vv-muds.ts            # dry run
 *   npx tsx scripts/add-missing-vv-muds.ts --apply    # write + geocode
 */
import { createClient } from '@supabase/supabase-js'
import { parseFlags, requireEnv } from './lib/cli'
import { upsertContact } from './lib/contact-upsert'
import { canonicaliseAuMobile, normalisePhone } from '../src/lib/phone'

const MUDS = [
  {
    recId: 'recHTMuZxWGNARg2I', area: 'VIN', mudCode: 'VIN-MUD-01', address: '103 Harold ST HIGHGATE',
    units: 67, cadence: 'Quarterly', // Airtable freq 2 → Quarterly per import-mud-properties toCadence
    contact: { first: 'Kendal', last: 'Garnett', email: 'kendal@abodestrata.com.au', phone: '0893682221' },
    notes: 'Collect from 40Mtrs down Stirling St on Verge (property on corner of Harold & Stirling St)\n\nCoV (John K.) confirmed continuation of bi-monthly collections as of 26/06/2026. - BA.\n\nStrata contact updated to Kendal as requested on 18-08-2026. - BA.',
  },
  {
    recId: 'recW8m4ZjcDN5ZQdP', area: 'VIN', mudCode: 'VIN-MUD-82', address: '28-40 Cowle ST WEST PERTH',
    units: 47, cadence: 'Ad-hoc',
    contact: { first: 'Kendal', last: '', email: 'kendal@abodestrata.com.au', phone: '08 9368 2221' },
    notes: 'Collect from front verge',
  },
  {
    recId: 'reckDjYPd7Q2rGBiC', area: 'VIN', mudCode: 'VIN-MUD-100', address: '99 Smith Street Highgate',
    units: 14, cadence: 'Ad-hoc',
    contact: { first: 'Megan', last: 'Lily', email: '1502@dohw.wa.gov.au', phone: '0864141436' },
    notes: 'Left handside of the driveway on grass verge',
  },
  {
    recId: 'rec333qshcCKorNSD', area: 'VIN', mudCode: 'VIN-MUD-105', address: '46 Smith St Highgate',
    units: 50, cadence: 'Quarterly', // freq 3
    contact: { first: 'Cygnet', last: 'West', email: 'strata.wa@cygnetwest.com', phone: '0863756000' },
    notes: 'Collect from front verge',
  },
  {
    recId: 'recbKlevORXE1gy2V', area: 'CAM-B', mudCode: 'CAM-MUD-44', address: '41-43 McCourt Street, West Leederville',
    units: 6, cadence: 'Bi-annual', // freq 6
    contact: { first: 'Faith', last: 'Rutherford', email: 'maintenance@cpropertygroup.com', phone: '61420718646' },
    notes: 'Collection on front verge, near the no-stopping sign.',
  },
] as const

/** One brain (src/lib/phone.ts): mobiles → E.164, landlines → formatting-stripped. */
function storePhone(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  return canonicaliseAuMobile(t) ?? normalisePhone(t)
}

async function main() {
  const apply = !!parseFlags(process.argv).apply
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const verco = createClient(url, serviceKey)
  console.log(`Add missing VV MUD properties (${apply ? 'APPLY' : 'DRY RUN'})`)

  const { data: areas, error: aErr } = await verco.from('collection_area').select('id, code').in('code', ['VIN', 'CAM-B'])
  if (aErr || !areas || areas.length !== 2) throw new Error(`areas: ${aErr?.message ?? 'not found'}`)
  const areaByCode = new Map(areas.map((a) => [a.code as string, a.id as string]))

  const createdIds: string[] = []
  let failures = 0
  for (const m of MUDS) {
    const { data: existing } = await verco.from('eligible_properties').select('id').eq('mud_code', m.mudCode).maybeSingle()
    if (existing) { console.log(`  = ${m.mudCode} already exists (${(existing as { id: string }).id}) — skipping`); continue }

    const { contactId, created, error: cErr } = await upsertContact(
      verco,
      { email: m.contact.email, firstName: m.contact.first, lastName: m.contact.last, mobileE164: storePhone(m.contact.phone) },
      !apply,
    )
    if (cErr) { console.error(`  ✗ ${m.mudCode} contact: ${cErr}`); failures++; continue }
    console.log(`  contact ${m.contact.email} → ${contactId ?? '(dry run)'}${created ? ' (created)' : ''}`)
    if (!apply) { console.log(`  + would create ${m.mudCode} "${m.address}" in ${m.area} (units=${m.units}, ${m.cadence})`); continue }

    const { data: prop, error: pErr } = await verco
      .from('eligible_properties')
      .insert({
        collection_area_id: areaByCode.get(m.area)!,
        address: m.address,
        formatted_address: null, latitude: null, longitude: null, google_place_id: null, has_geocode: false,
        is_mud: true,
        external_source: 'airtable-mud', external_id: m.recId,
        unit_count: m.units, mud_code: m.mudCode, mud_onboarding_status: 'Contact Made',
        collection_cadence: m.cadence, waste_location_notes: m.notes, strata_contact_id: contactId,
      })
      .select('id')
      .single()
    if (pErr) { console.error(`  ✗ ${m.mudCode}: ${pErr.message}`); failures++; continue }
    createdIds.push((prop as { id: string }).id)
    console.log(`  + created ${m.mudCode} "${m.address}" → ${(prop as { id: string }).id}`)
  }

  if (apply && createdIds.length > 0) {
    console.log(`\nGeocoding ${createdIds.length} new properties via geocode-properties EF…`)
    const res = await fetch(`${url}/functions/v1/geocode-properties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ property_ids: createdIds }),
    })
    console.log(`  EF HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`)
  }
  if (failures > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
