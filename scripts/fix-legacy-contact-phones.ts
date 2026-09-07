// scripts/fix-legacy-contact-phones.ts
/**
 * Canonicalise `contacts.mobile_e164` for contacts created by a legacy
 * (Airtable CSV) bookings import. The 23/08 VIN import wrote the Airtable cell
 * verbatim ("+61 402 439 879", "+61 0449 …", landlines) — 991/1,001 contacts —
 * which breaks SMS dispatch (`/^\+614\d{8}$/`). Store rule (src/lib/phone.ts):
 * mobiles → E.164 via canonicaliseAuMobile; anything else → formatting-stripped.
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/fix-legacy-contact-phones.ts --area=VIN --since=2026-08-23            # dry run
 *   npx tsx scripts/fix-legacy-contact-phones.ts --area=VIN --since=2026-08-23 --apply
 */
import { createClient } from '@supabase/supabase-js'
import { canonicaliseAuMobile, normalisePhone } from '../src/lib/phone'
import { parseFlags, requireEnv } from './lib/cli'

/** Store-rule transform; returns null when the value is already canonical. */
export function fixPhone(raw: string): string | null {
  const to = canonicaliseAuMobile(raw) ?? normalisePhone(raw.trim())
  return to === raw ? null : to
}

async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const areaCode = typeof flags.area === 'string' ? flags.area : null
  const since = typeof flags.since === 'string' ? flags.since : null
  if (!areaCode || !since) { console.error('Usage: --area=<CODE> --since=YYYY-MM-DD [--apply]'); process.exit(1) }
  const unknown = Object.keys(flags).filter((k) => !['apply', 'area', 'since'].includes(k))
  if (unknown.length) { console.error(`Unknown flag(s): ${unknown.join(', ')}`); process.exit(1) }

  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  const { data: area } = await verco.from('collection_area').select('id').eq('code', areaCode).single()
  if (!area) throw new Error(`collection_area ${areaCode} not found`)

  // Contacts created on/after the import day AND linked to a legacy booking in
  // the area — never touches contacts that pre-existed the import.
  const { data: rows, error } = await verco
    .from('contacts')
    .select('id, mobile_e164, booking!inner(collection_area_id, created_via)')
    .eq('booking.collection_area_id', area.id)
    .eq('booking.created_via', 'legacy')
    .gte('created_at', `${since}T00:00:00Z`)
    .limit(5000)
  if (error) throw new Error(error.message)

  const seen = new Set<string>()
  const plan: { id: string; from: string; to: string }[] = []
  let ok = 0
  for (const r of rows ?? []) {
    if (seen.has(r.id) || !r.mobile_e164) continue
    seen.add(r.id)
    const to = fixPhone(r.mobile_e164)
    if (!to) { ok++; continue }
    plan.push({ id: r.id, from: r.mobile_e164, to })
  }
  const mobiles = plan.filter((p) => p.to.startsWith('+614')).length
  console.log(`${areaCode} legacy contacts: ${seen.size}; already canonical: ${ok}; to fix: ${plan.length} (${mobiles} mobiles → E.164, ${plan.length - mobiles} landline/other stripped)`)
  console.log('samples:', plan.slice(0, 5).map((p) => `${p.from} → ${p.to}`).join(' | '))
  if (!apply) { console.log('DRY RUN — re-run with --apply'); return }
  let n = 0
  for (const p of plan) {
    const { error: uErr } = await verco.from('contacts').update({ mobile_e164: p.to }).eq('id', p.id)
    if (uErr) { console.error(`✗ ${p.id}: ${uErr.message}`); process.exit(1) }
    n++
  }
  console.log(`Updated ${n}/${plan.length}.`)
}

if (process.argv[1]?.endsWith('fix-legacy-contact-phones.ts')) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1) })
}
