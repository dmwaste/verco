// scripts/attach-mud-strata-contacts.ts
/**
 * Attach a strata contact to EXISTING Verco MUD properties that have none,
 * from the Airtable MUD List — so the MUD bookings import stops dropping their
 * bookings (`skip · no strata contact`). 30/09/2026 VV changeover: SOP-MUD-32
 * (06/10) and SOP-MUD-58 (03/11).
 *
 * Why not import-mud-properties.ts --only: its Pass 1 re-upserts the whole row
 * (geocode → NULL, status → Contact Made). This touches strata_contact_id only,
 * and only where it is still NULL — never overwrites a contact, never guesses
 * between duplicate MUD codes (either side).
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/attach-mud-strata-contacts.ts --refs=SOP-MUD-32,SOP-MUD-58            # dry run
 *   npx tsx scripts/attach-mud-strata-contacts.ts --refs=SOP-MUD-32,SOP-MUD-58 --apply    # write
 *   optional: --base=appXXXXXXXXXXXXXX (Airtable base; default the main VV base)
 */
import { createClient } from '@supabase/supabase-js'
import { parseFlags, requireEnv } from './lib/cli'
import { fetchAllMudRecords, MUD_BASE_ID } from './lib/airtable-mud'
import { mudContactInput, upsertContact } from './lib/contact-upsert'

type MudRec = { id: string; mudRef: string | null; contactName: string | null; contactNumber: string | null; email: string | null }
type Prop = { id: string; mud_code: string | null; strata_contact_id: string | null }

const key = (s: string | null) => (s ?? '').trim().toUpperCase()

export function planStrataAttach(records: MudRec[], props: Prop[], refs: string[]) {
  const plans: { ref: string; propertyId: string; recId: string; contact: ReturnType<typeof mudContactInput> }[] = []
  const skips: { ref: string; reason: string }[] = []
  for (const ref of refs) {
    const recs = records.filter((r) => key(r.mudRef) === key(ref))
    const rows = props.filter((p) => key(p.mud_code) === key(ref))
    const skip = (reason: string) => skips.push({ ref, reason })
    if (recs.length === 0) { skip('not in Airtable MUD List'); continue }
    if (recs.length > 1) { skip(`ambiguous in Airtable (${recs.length} rows)`); continue }
    if (rows.length === 0) { skip('no Verco property'); continue }
    if (rows.length > 1) { skip(`ambiguous in Verco (${rows.length} rows)`); continue }
    if (rows[0]!.strata_contact_id) { skip('Verco property already has a strata contact'); continue }
    const contact = mudContactInput(recs[0]!)
    if (!contact.email) { skip('no email in Airtable'); continue }
    plans.push({ ref, propertyId: rows[0]!.id, recId: recs[0]!.id, contact })
  }
  return { plans, skips }
}

async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const base = typeof flags.base === 'string' ? flags.base : MUD_BASE_ID
  const refs = typeof flags.refs === 'string' ? flags.refs.split(',').map((s) => s.trim()).filter(Boolean) : []
  const unknown = Object.keys(flags).filter((k) => !['apply', 'base', 'refs'].includes(k))
  if (unknown.length) { console.error(`Unknown flag(s): ${unknown.join(', ')}`); process.exit(1) }
  if (refs.length === 0 || !/^app[A-Za-z0-9]{14}$/.test(base)) { console.error('Usage: --refs=MUD-REF,MUD-REF [--base=appXXXXXXXXXXXXXX] [--apply]'); process.exit(1) }

  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  console.log(`Attach strata contacts (${apply ? 'APPLY' : 'DRY RUN'})  base=${base}  refs=${refs.join(',')}`)

  const records = await fetchAllMudRecords(requireEnv('AIRTABLE_TOKEN'), base)
  const { data: props, error } = await verco
    .from('eligible_properties')
    .select('id, mud_code, strata_contact_id')
    .eq('is_mud', true)
    .in('mud_code', refs)
  if (error) throw new Error(error.message)

  const { plans, skips } = planStrataAttach(records, (props ?? []) as Prop[], refs)
  for (const s of skips) console.log(`  skip  ${s.ref}: ${s.reason}`)
  for (const p of plans) console.log(`  plan  ${p.ref}: property ${p.propertyId} ← Airtable ${p.recId} (${p.contact.email})`)
  if (!apply) { console.log(`\nDRY RUN — re-run with --apply to attach ${plans.length} contact(s).`); return }

  let failures = 0
  for (const p of plans) {
    const c = await upsertContact(verco, p.contact, false)
    if (c.error || !c.contactId) { console.error(`  ✗ ${p.ref}: contact ${c.error ?? 'no id'}`); failures++; continue }
    const { data, error: uErr } = await verco
      .from('eligible_properties')
      .update({ strata_contact_id: c.contactId })
      .eq('id', p.propertyId)
      .is('strata_contact_id', null)
      .select('id')
    if (uErr || !data?.length) { console.error(`  ✗ ${p.ref}: ${uErr?.message ?? '0 rows updated (contact set meanwhile?)'}`); failures++; continue }
    console.log(`  ✓ ${p.ref}: contact ${c.contactId}${c.created ? ' (created)' : ' (existing)'}`)
  }
  if (failures) process.exit(1)
}

if (process.argv[1]?.endsWith('attach-mud-strata-contacts.ts')) {
  main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
}
