// scripts/backfill-vv-waste-notes.ts
/**
 * One-time backfill of the VV (COT/MOS/PEP) legacy Airtable Waste_Notes into
 * Verco booking.notes.
 *
 * The go-live import mapped Waste_Location → booking.location but dropped the
 * free-text Waste_Notes (resident placement instructions the crew reads on the
 * run sheet + in the OptimoRoute order). This script backfills them:
 *   - dry-run (default): writes a review report (md + csv) and prints counts.
 *     No writes.
 *   - --apply: sets booking.notes for the matched, still-blank bookings only.
 *
 * Idempotent: only bookings whose notes are currently blank are ever touched,
 * so a re-run (or overlap with the reconcile note-fill action) is a no-op.
 *
 * Match bridge: Verco eligible_properties.external_id == Airtable Eligible
 * Properties record id, then property → collection date (see lib/note-backfill).
 *
 * Usage:
 *   set -a; . /path/to/.env.local; set +a
 *   npx tsx scripts/backfill-vv-waste-notes.ts                 # dry-run report
 *   npx tsx scripts/backfill-vv-waste-notes.ts --councils=COT  # one council
 *   npx tsx scripts/backfill-vv-waste-notes.ts --apply         # apply the fills
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import { loadAreaMap } from './lib/area-map'
import { fetchConsolidatedBookings } from './lib/airtable-bookings'
import { planNoteBackfill, type NoteBackfillBooking, type NoteBackfillPlan } from './lib/note-backfill'

const DEFAULT_COUNCILS = ['MOS', 'COT', 'PEP']
const SOURCE_BASE_ID = 'appWSysd50QoVaaRD' // "Verge Valet Bookings"

async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const councils =
    typeof flags.councils === 'string' ? flags.councils.split(',').map((c) => c.trim().toUpperCase()) : DEFAULT_COUNCILS

  const airtableToken = requireEnv('AIRTABLE_TOKEN')
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const verco = createClient(supabaseUrl, serviceKey)

  console.log(`Backfilling Waste_Notes for councils: ${councils.join(', ')}  (${apply ? 'APPLY' : 'DRY RUN'})`)

  // 1. Verco: legacy bookings with blank notes in the target areas.
  const areaMap = await loadAreaMap(verco)
  const areaByCode = new Map(councils.map((c) => [c, areaMap.get(c)]))
  const areaIds = [...areaByCode.values()].filter((x): x is string => !!x)
  if (areaIds.length !== councils.length) {
    const missing = councils.filter((c) => !areaMap.get(c))
    throw new Error(`No Verco collection_area for council code(s): ${missing.join(', ')}`)
  }
  const areaCode = new Map<string, string>()
  for (const [code, id] of areaByCode) if (id) areaCode.set(id, code)

  const bookings = await loadBlankNoteBookings(verco, areaIds, areaCode)
  console.log(`Verco: ${bookings.length} legacy bookings with blank notes across ${areaIds.length} areas.`)

  // 2. Airtable master rows for these councils (includes Waste_Notes).
  const { rows: source, skipped } = await fetchConsolidatedBookings(SOURCE_BASE_ID, airtableToken, councils)
  const withNotes = source.filter((s) => s.wasteNotes && s.wasteNotes.trim() !== '').length
  console.log(`Airtable master: ${source.length} council rows (${withNotes} carry a Waste_Note); ${skipped} unparseable skipped.`)

  // 3. Plan.
  const plan = planNoteBackfill(bookings, source)
  printSummary(plan)

  // 4. Report.
  const stamp = timestamp()
  const paths = writeReport(plan, stamp, { councils, apply })
  console.log(`\nReport written:\n  ${paths.md}\n  ${paths.csv}`)

  // 5. Apply.
  if (apply) await executeFills(verco, plan)
  else console.log(`\nDRY RUN — no writes. Re-run with --apply to set ${plan.fills.length} booking notes.`)
}

// ─── Verco load ────────────────────────────────────────────────────────────────

async function loadBlankNoteBookings(
  verco: SupabaseClient,
  areaIds: string[],
  areaCode: Map<string, string>,
): Promise<NoteBackfillBooking[]> {
  // Only legacy rows with blank notes — the import-caused gap. Resident/admin
  // bookings capture their own notes and have no Airtable master row anyway.
  const rows = await pagedIn<{
    id: string
    ref: string
    notes: string | null
    property_id: string | null
    collection_area_id: string
  }>(
    verco,
    'booking',
    'id, ref, notes, property_id, collection_area_id',
    'collection_area_id',
    areaIds,
    (q) => q.eq('created_via', 'legacy').or('notes.is.null,notes.eq.'),
  )

  const propertyIds = uniq(rows.map((b) => b.property_id).filter((x): x is string => !!x))
  const props = await pagedIn<{ id: string; external_id: string | null }>(
    verco,
    'eligible_properties',
    'id, external_id',
    'id',
    propertyIds,
  )
  const extIdOf = new Map(props.map((p) => [p.id, p.external_id]))

  const bookingIds = rows.map((b) => b.id)
  const items = await pagedIn<{ booking_id: string; collection_date_id: string | null }>(
    verco,
    'booking_item',
    'booking_id, collection_date_id',
    'booking_id',
    bookingIds,
  )
  const dateIds = uniq(items.map((i) => i.collection_date_id).filter((x): x is string => !!x))
  const cdates = await pagedIn<{ id: string; date: string }>(verco, 'collection_date', 'id, date', 'id', dateIds)
  const dateOf = new Map(cdates.map((d) => [d.id, d.date]))

  // Earliest collection date per booking (mirrors the reconcile loader).
  const minDate = new Map<string, string | null>()
  for (const it of items) {
    const d = it.collection_date_id ? dateOf.get(it.collection_date_id) ?? null : null
    const cur = minDate.get(it.booking_id) ?? null
    if (d && (!cur || d < cur)) minDate.set(it.booking_id, d)
    else if (!minDate.has(it.booking_id)) minDate.set(it.booking_id, cur)
  }

  return rows.map((b) => ({
    id: b.id,
    ref: b.ref,
    area: areaCode.get(b.collection_area_id) ?? '?',
    notes: b.notes,
    propertyExternalId: b.property_id ? extIdOf.get(b.property_id) ?? null : null,
    collectionDate: minDate.get(b.id) ?? null,
  }))
}

// ─── Apply ───────────────────────────────────────────────────────────────────

async function executeFills(verco: SupabaseClient, plan: NoteBackfillPlan) {
  const fail: { ref: string; error: string }[] = []
  let done = 0
  for (const fill of plan.fills) {
    // Guard the write to still-blank rows so a concurrent edit is never clobbered.
    const { error, count } = await verco
      .from('booking')
      .update({ notes: fill.note }, { count: 'exact' })
      .eq('id', fill.bookingId)
      .or('notes.is.null,notes.eq.')
    if (error) fail.push({ ref: fill.ref, error: error.message })
    else if (count === 0) fail.push({ ref: fill.ref, error: 'skipped — notes no longer blank' })
    else done++
  }
  console.log(`\n─ applied ─\n  notes filled: ${done}`)
  if (fail.length) {
    console.log(`\n${fail.length} not applied:`)
    for (const f of fail) console.error(`  ✗ ${f.ref}: ${f.error}`)
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printSummary(plan: NoteBackfillPlan) {
  console.log('\n═════════ Note backfill summary ═════════')
  console.log(`  fills (same-date)      ${plan.fills.length}`)
  console.log(`  note on other round    ${plan.otherDateOnly.length}   (not filled — stale prior round)`)
  console.log(`  no master note         ${plan.noSourceNote}`)
  console.log(`  no property id         ${plan.noProperty}`)
  console.log(`  already had notes      ${plan.alreadyHasNotes}`)
}

function writeReport(plan: NoteBackfillPlan, stamp: string, meta: { councils: string[]; apply: boolean }): { md: string; csv: string } {
  const base = `backfill-vv-waste-notes-report-${stamp}`

  const header = 'ref,area,collection_date,source_ref,note'
  const csvRows = plan.fills.map((f) => [f.ref, f.area, f.date ?? '', f.sourceRef, f.note].map(csvCell).join(','))
  const csv = [header, ...csvRows].join('\n')

  const md: string[] = []
  md.push(`# VV Waste_Notes backfill — ${stamp}`)
  md.push('')
  md.push(`Councils: **${meta.councils.join(', ')}** · Mode: **${meta.apply ? 'APPLY' : 'DRY RUN'}** · Fills: **${plan.fills.length}** (same-date matches only)`)
  md.push('')
  md.push('| ref | area | date | source | note |')
  md.push('|---|---|---|---|---|')
  for (const f of plan.fills) {
    md.push(`| ${f.ref} | ${f.area} | ${f.date ?? '—'} | ${f.sourceRef} | ${trunc(f.note, 90)} |`)
  }
  if (plan.otherDateOnly.length) {
    md.push('')
    md.push(`## Not filled — Airtable note exists only on a different round (${plan.otherDateOnly.length})`)
    md.push('')
    md.push('These bookings have a blank note; the property has a note in Airtable, but on a different collection date (stale prior round), so it was NOT applied. Eyeball if any are genuinely current.')
    md.push('')
    md.push('| ref | area | booking date | source date | source | note |')
    md.push('|---|---|---|---|---|---|')
    for (const a of plan.otherDateOnly) md.push(`| ${a.ref} | ${a.area} | ${a.date ?? '—'} | ${a.sourceDate ?? '—'} | ${a.sourceRef} | ${trunc(a.note, 60)} |`)
  }

  const mdPath = `${base}.md`
  const csvPath = `${base}.csv`
  writeFileSync(mdPath, md.join('\n'))
  writeFileSync(csvPath, csv)
  return { md: mdPath, csv: csvPath }
}

// ─── Small helpers ─────────────────────────────────────────────────────────────

type Filterable = { eq: (c: string, v: string) => Filterable; or: (f: string) => Filterable }

async function pagedIn<T>(
  verco: SupabaseClient,
  table: string,
  select: string,
  column: string,
  values: string[],
  refine?: (q: Filterable) => Filterable,
): Promise<T[]> {
  const out: T[] = []
  const CHUNK = 100
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    let q = verco.from(table).select(select).in(column, chunk) as unknown as Filterable
    if (refine) q = refine(q)
    const { data, error } = (await (q as unknown as PromiseLike<{ data: T[] | null; error: { message: string } | null }>))
    if (error) throw new Error(`load ${table}: ${error.message}`)
    out.push(...((data ?? []) as T[]))
  }
  return out
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)]
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function trunc(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

function timestamp(): string {
  const d = new Date()
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
