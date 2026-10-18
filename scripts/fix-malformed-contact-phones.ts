// scripts/fix-malformed-contact-phones.ts
/**
 * Repair malformed `contacts.mobile_e164` values across ALL tenants (18/10/2026
 * audit). Mobiles stored raw (typed without the 0, or re-prefixed +44 / +1 by
 * browser autofill) get no SMS reminders and don't match the Teams caller lookup
 * (VER-316). The rules are in scripts/lib/phone-repair.ts: only provably-same
 * numbers are fixed. Everything else is listed for staff to check with the
 * resident, by contact id and newest booking ref; numbers are never printed
 * unmasked.
 *
 * Each update is guarded on the value read, so a number staff changed since is
 * left alone, and audit_trigger_fn logs old → new (reversible from audit_log).
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/fix-malformed-contact-phones.ts            # dry run
 *   npx tsx scripts/fix-malformed-contact-phones.ts --apply
 */
import { createClient } from '@supabase/supabase-js'
import { parseFlags, requireEnv } from './lib/cli'
import { pagedIn } from './lib/db'
import { maskPhone, repairStoredPhone, type RepairRule } from './lib/phone-repair'

const PAGE = 1000

interface Fix { id: string; from: string; to: string | null; rule: RepairRule }

async function main() {
  const flags = parseFlags(process.argv)
  const unknown = Object.keys(flags).filter((k) => k !== 'apply')
  if (unknown.length) { console.error(`Unknown flag(s): ${unknown.join(', ')}`); process.exit(1) }
  const apply = !!flags.apply

  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))

  // Ordered by id: range() without order() skips and duplicates rows.
  const rows: { id: string; mobile_e164: string }[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await verco
      .from('contacts')
      .select('id, mobile_e164')
      .not('mobile_e164', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load contacts: ${error.message}`)
    rows.push(...(data as { id: string; mobile_e164: string }[]))
    if (data.length < PAGE) break
  }

  const fixes: Fix[] = []
  const manual: { id: string; from: string }[] = []
  for (const r of rows) {
    const repair = repairStoredPhone(r.mobile_e164)
    if (repair.action === 'fix') fixes.push({ id: r.id, from: r.mobile_e164, to: repair.to, rule: repair.rule })
    else if (repair.action === 'manual') manual.push({ id: r.id, from: r.mobile_e164 })
  }

  console.log(`Contacts with a stored number: ${rows.length}. To fix: ${fixes.length}. For staff: ${manual.length}.`)
  const byRule = new Map<RepairRule, Fix[]>()
  for (const f of fixes) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f])
  for (const [rule, list] of byRule) {
    const samples = list.slice(0, 3).map((f) => `${maskPhone(f.from)} → ${f.to === null ? 'NULL' : maskPhone(f.to)}`)
    console.log(`  ${rule.padEnd(21)} ${String(list.length).padStart(4)}   e.g. ${samples.join(' | ')}`)
  }

  if (manual.length > 0) {
    const bookings = await pagedIn<{ ref: string; contact_id: string; created_at: string }>(
      verco, 'booking', 'ref, contact_id, created_at', 'contact_id', manual.map((m) => m.id),
    )
    const newestRef = new Map<string, { ref: string; at: string }>()
    for (const b of bookings) {
      const cur = newestRef.get(b.contact_id)
      if (!cur || b.created_at > cur.at) newestRef.set(b.contact_id, { ref: b.ref, at: b.created_at })
    }
    console.log('\nFor staff to check with the resident (contact id, newest booking, stored shape):')
    for (const m of manual) console.log(`  ${m.id}  ${newestRef.get(m.id)?.ref ?? '(no booking)'}  ${maskPhone(m.from)}`)
  }

  if (!apply) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return }

  let updated = 0
  let skipped = 0
  let failed = 0
  for (const f of fixes) {
    const { data, error } = await verco
      .from('contacts')
      .update({ mobile_e164: f.to })
      .eq('id', f.id)
      .eq('mobile_e164', f.from)
      .select('id')
    if (error) { console.error(`✗ ${f.id}: ${error.message}`); failed++; continue }
    if (data.length === 1) updated++
    else skipped++
  }
  console.log(`\nUpdated ${updated}/${fixes.length}. Changed since the read (left alone): ${skipped}. Failed: ${failed}.`)
  if (failed > 0) process.exit(1)
}

if (process.argv[1]?.endsWith('fix-malformed-contact-phones.ts')) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1) })
}
