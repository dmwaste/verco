// scripts/reconcile-vv-bookings.ts
/**
 * Reconcile Verco MOS/COT/PEP bookings against the consolidated Airtable
 * `Bookings` master.
 *
 * The go-live import loaded these councils from the per-council "BR" intake
 * tables (frozen original requests) instead of the consolidated master (where
 * cancellations / reschedules / edits are made). This script diffs the two and:
 *   - dry-run (default): writes a review report (md + csv + json) and prints
 *     per-class counts. No writes.
 *   - --apply: applies the SAFE, non-blocked fixes only — cancellations and
 *     date changes. Blocked rows (past cutoff / dispatched / collisions) and
 *     missing/phantom rows are always left for manual handling.
 *
 * Match bridge: Verco eligible_properties.external_id == Airtable Eligible
 * Properties record id. There is no Airtable booking id on the Verco row, so we
 * pair on property → date → coarse stream signature (see lib/reconcile.ts).
 *
 * Usage:
 *   set -a; . /path/to/.env.local; set +a
 *   npx tsx scripts/reconcile-vv-bookings.ts                 # dry-run report
 *   npx tsx scripts/reconcile-vv-bookings.ts --councils=COT  # one council
 *   npx tsx scripts/reconcile-vv-bookings.ts --apply         # apply safe fixes
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import { loadAreaMap } from './lib/area-map'
import { fetchConsolidatedBookings } from './lib/airtable-bookings'
import {
  reconcile,
  countByClass,
  CLASS_ORDER,
  RESCHEDULE_MAX_DAYS,
  type Finding,
  type VercoBooking,
} from './lib/reconcile'

const DEFAULT_COUNCILS = ['MOS', 'COT', 'PEP']
const SOURCE_BASE_ID = 'appWSysd50QoVaaRD' // "Verge Valet Bookings"
/**
 * Include master rows whose date lands within [min imported date, max + buffer].
 * The buffer matches the reschedule proximity so a booking moved just past the
 * imported round is still considered, without dragging in the next round.
 */
const WINDOW_BUFFER_DAYS = RESCHEDULE_MAX_DAYS

async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const councils =
    typeof flags.councils === 'string' ? flags.councils.split(',').map((c) => c.trim().toUpperCase()) : DEFAULT_COUNCILS

  const airtableToken = requireEnv('AIRTABLE_TOKEN')
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const verco = createClient(supabaseUrl, serviceKey)

  console.log(`Reconciling councils: ${councils.join(', ')}  (${apply ? 'APPLY' : 'DRY RUN'})`)

  // 1. Load Verco bookings for the target areas.
  const areaMap = await loadAreaMap(verco)
  const areaIds = councils.map((c) => areaMap.get(c)).filter((x): x is string => !!x)
  if (areaIds.length !== councils.length) {
    const missing = councils.filter((c) => !areaMap.get(c))
    throw new Error(`No Verco collection_area for council code(s): ${missing.join(', ')}`)
  }
  const vercoBookings = await loadVercoBookings(verco, areaIds)
  console.log(`Verco: ${vercoBookings.length} bookings across ${areaIds.length} areas.`)

  // 2. Window derived from the imported bookings (guards against pulling old rounds).
  const dates = vercoBookings.map((b) => b.collectionDate).filter((d): d is string => !!d).sort()
  const windowStart = dates[0] ?? '2000-01-01'
  const windowEnd = addDays(dates[dates.length - 1] ?? '2100-01-01', WINDOW_BUFFER_DAYS)

  // 3. Fetch the consolidated master, filter to dated rows inside the window.
  //    Undated rows are almost all stale completed collections from prior rounds
  //    (a null collection-date link) — they can't anchor a date comparison and
  //    would otherwise mis-pair with current bookings at the same property.
  const { rows: allSource, skipped } = await fetchConsolidatedBookings(SOURCE_BASE_ID, airtableToken, councils)
  const undated = allSource.filter((s) => !s.collectionDate).length
  const source = allSource.filter((s) => s.collectionDate != null && inWindow(s.collectionDate, windowStart, windowEnd))
  console.log(
    `Airtable master: ${allSource.length} council rows; ${source.length} dated + in window ` +
      `[${windowStart} … ${windowEnd}]; ${undated} undated excluded; ${skipped} unparseable skipped.`,
  )

  // 4. Reconcile.
  const findings = reconcile(vercoBookings, source, new Date())
  const counts = countByClass(findings)

  // 5. Report.
  const stamp = timestamp()
  const paths = writeReport(findings, counts, stamp, { councils, windowStart, windowEnd, apply })
  printSummary(counts, findings)
  console.log(`\nReport written:\n  ${paths.md}\n  ${paths.csv}\n  ${paths.json}`)

  // 6. Apply (cancellations only; everything else is manual — see report).
  if (apply) {
    await applyFixes(verco, findings)
  } else {
    const auto = findings.filter((f) => f.class === 'cancelled_in_source' && !f.needsManual)
    console.log(
      `\nDRY RUN — ${auto.length} cancellation(s) would be auto-applied with --apply. ` +
        `Date changes, missing, phantom and modified rows are report-only (manual). Review the report first.`,
    )
  }
}

// ─── Verco data load (chunked queries; avoids the multi-FK embed gotcha) ──────

async function loadVercoBookings(verco: SupabaseClient, areaIds: string[]): Promise<VercoBooking[]> {
  const areaCode = new Map<string, string>()
  {
    const { data, error } = await verco.from('collection_area').select('id, code').in('id', areaIds)
    if (error) throw new Error(`load areas: ${error.message}`)
    for (const a of data ?? []) areaCode.set(a.id, a.code)
  }

  const bookings = await pagedIn<{
    id: string
    ref: string
    status: string
    created_at: string
    property_id: string | null
    collection_area_id: string
  }>(verco, 'booking', 'id, ref, status, created_at, property_id, collection_area_id', 'collection_area_id', areaIds)

  const bookingIds = bookings.map((b) => b.id)
  const propertyIds = uniq(bookings.map((b) => b.property_id).filter((x): x is string => !!x))

  const props = await pagedIn<{ id: string; external_id: string | null; address: string | null }>(
    verco,
    'eligible_properties',
    'id, external_id, address',
    'id',
    propertyIds,
  )
  const propMap = new Map(props.map((p) => [p.id, p]))

  const items = await pagedIn<{
    booking_id: string
    no_services: number
    service_id: string
    collection_date_id: string | null
  }>(verco, 'booking_item', 'booking_id, no_services, service_id, collection_date_id', 'booking_id', bookingIds)

  const serviceIds = uniq(items.map((i) => i.service_id))
  const services = await pagedIn<{ id: string; name: string }>(verco, 'service', 'id, name', 'id', serviceIds)
  const serviceName = new Map(services.map((s) => [s.id, s.name]))

  const dateIds = uniq(items.map((i) => i.collection_date_id).filter((x): x is string => !!x))
  const cdates = await pagedIn<{ id: string; date: string }>(verco, 'collection_date', 'id, date', 'id', dateIds)
  const dateOf = new Map(cdates.map((d) => [d.id, d.date]))

  const stops = await pagedIn<{ booking_id: string; pushed_at: string | null }>(
    verco,
    'collection_stop',
    'booking_id, pushed_at',
    'booking_id',
    bookingIds,
  )
  const dispatched = new Set(stops.filter((s) => s.pushed_at != null).map((s) => s.booking_id))

  // Aggregate items per booking.
  const agg = new Map<string, { bulk: number; green: number; mattress: number; minDate: string | null }>()
  for (const it of items) {
    const a = agg.get(it.booking_id) ?? { bulk: 0, green: 0, mattress: 0, minDate: null }
    const name = serviceName.get(it.service_id) ?? ''
    const qty = it.no_services ?? 0
    if (name === 'Green Waste') a.green += qty
    else if (name === 'Mattress') a.mattress += qty
    else a.bulk += qty // Bulk Waste, Whitegoods, E-Waste → Airtable "No_Bulk" bucket
    const d = it.collection_date_id ? dateOf.get(it.collection_date_id) ?? null : null
    if (d && (!a.minDate || d < a.minDate)) a.minDate = d
    agg.set(it.booking_id, a)
  }

  return bookings.map((b) => {
    const a = agg.get(b.id) ?? { bulk: 0, green: 0, mattress: 0, minDate: null }
    const prop = b.property_id ? propMap.get(b.property_id) : undefined
    return {
      id: b.id,
      ref: b.ref,
      area: areaCode.get(b.collection_area_id) ?? '?',
      address: prop?.address ?? '',
      propertyExternalId: prop?.external_id ?? null,
      collectionDate: a.minDate,
      status: b.status,
      importedAt: b.created_at,
      bulkCount: a.bulk,
      greenCount: a.green,
      mattressCount: a.mattress,
      isDispatched: dispatched.has(b.id),
    }
  })
}

// ─── Apply (Phase 2) ──────────────────────────────────────────────────────────

async function applyFixes(verco: SupabaseClient, findings: Finding[]) {
  // Only cancellations are auto-applied. Date changes are always manual (a date
  // move can't be distinguished from a separate new booking without a stable id),
  // and missing/phantom rows need human judgement. The DB triggers still gate
  // every write — a past-cutoff row we somehow attempt is rejected here too.
  const cancels = findings.filter((f) => f.class === 'cancelled_in_source' && !f.needsManual)
  console.log(`\nApplying ${cancels.length} cancellation(s)…`)

  let cancelled = 0
  const failures: { ref: string; error: string }[] = []
  for (const f of cancels) {
    const v = f.verco!
    const { error } = await verco
      .from('booking')
      .update({
        status: 'Cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: `Reconciliation: cancelled in Airtable master (${f.source?.bookingRef ?? '—'})`,
      })
      .eq('id', v.id)
    if (error) failures.push({ ref: v.ref, error: error.message })
    else cancelled++
  }

  console.log(`Cancelled: ${cancelled}/${cancels.length}`)
  for (const f of failures) console.error(`  ✗ ${f.ref}: ${f.error}`)
  console.log('Date-change, missing, phantom and manual-flagged rows were left for manual handling (see report).')
}

// ─── Report ───────────────────────────────────────────────────────────────────

function writeReport(
  findings: Finding[],
  counts: Record<string, number>,
  stamp: string,
  meta: { councils: string[]; windowStart: string; windowEnd: string; apply: boolean },
): { md: string; csv: string; json: string } {
  const base = `reconcile-vv-report-${stamp}`
  const ordered = [...findings].sort(
    (a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class) || (a.verco?.ref ?? '').localeCompare(b.verco?.ref ?? ''),
  )

  // CSV
  const header = 'class,verco_ref,area,address,verco_status,source_status,source_ref,verco_date,source_date,modified_at,imported_at,blocked_reason,needs_manual,proposed_action'
  const csvRows = ordered.map((f) =>
    [
      f.class,
      f.verco?.ref ?? '',
      f.verco?.area ?? '',
      f.verco?.address ?? f.source?.propertyRecId ?? '',
      f.verco?.status ?? '',
      f.source?.status ?? '',
      f.source?.bookingRef ?? '',
      f.verco?.collectionDate ?? '',
      f.source?.collectionDate ?? '',
      f.source?.modifiedAt ?? '',
      f.verco?.importedAt ?? '',
      f.blockedReason ?? '',
      f.needsManual ? 'yes' : 'no',
      f.proposedAction,
    ]
      .map(csvCell)
      .join(','),
  )
  const csv = [header, ...csvRows].join('\n')

  // Markdown
  const md: string[] = []
  md.push(`# VV MOS/COT/PEP booking reconciliation — ${stamp}`)
  md.push('')
  md.push(`Councils: **${meta.councils.join(', ')}** · Window: **${meta.windowStart} … ${meta.windowEnd}** · Mode: **${meta.apply ? 'APPLY' : 'DRY RUN'}**`)
  md.push('')
  md.push('| Class | Count |')
  md.push('|---|---:|')
  for (const c of CLASS_ORDER) md.push(`| ${c} | ${counts[c] ?? 0} |`)
  md.push(`| **total** | **${findings.length}** |`)
  md.push('')
  for (const c of CLASS_ORDER) {
    if (c === 'in_sync') continue
    const rows = ordered.filter((f) => f.class === c)
    if (rows.length === 0) continue
    md.push(`## ${c} (${rows.length})`)
    md.push('')
    md.push('| verco_ref | area | address | verco | source | v_date | s_date | modified_at | manual | action |')
    md.push('|---|---|---|---|---|---|---|---|:--:|---|')
    for (const f of rows) {
      md.push(
        `| ${f.verco?.ref ?? '—'} | ${f.verco?.area ?? '—'} | ${trunc(f.verco?.address ?? f.source?.propertyRecId ?? '', 34)} | ${f.verco?.status ?? '—'} | ${f.source?.status ?? '—'} | ${f.verco?.collectionDate ?? '—'} | ${f.source?.collectionDate ?? '—'} | ${f.source?.modifiedAt?.slice(0, 10) ?? '—'} | ${f.needsManual ? '⚠️' : ''} | ${f.proposedAction} |`,
      )
    }
    md.push('')
  }

  const mdPath = `${base}.md`
  const csvPath = `${base}.csv`
  const jsonPath = `${base}.json`
  writeFileSync(mdPath, md.join('\n'))
  writeFileSync(csvPath, csv)
  writeFileSync(jsonPath, JSON.stringify({ meta, counts, findings }, null, 2))
  return { md: mdPath, csv: csvPath, json: jsonPath }
}

function printSummary(counts: Record<string, number>, findings: Finding[]) {
  console.log('\n═════════ Reconciliation summary ═════════')
  for (const c of CLASS_ORDER) console.log(`  ${c.padEnd(22)} ${counts[c] ?? 0}`)
  console.log(`  ${'TOTAL'.padEnd(22)} ${findings.length}`)
}

// ─── Small helpers ─────────────────────────────────────────────────────────────

async function pagedIn<T>(
  verco: SupabaseClient,
  table: string,
  select: string,
  column: string,
  values: string[],
): Promise<T[]> {
  const out: T[] = []
  const CHUNK = 100
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    const { data, error } = await verco.from(table).select(select).in(column, chunk)
    if (error) throw new Error(`load ${table}: ${error.message}`)
    out.push(...((data ?? []) as T[]))
  }
  return out
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)]
}

function inWindow(date: string, start: string, end: string): boolean {
  return date >= start && date <= end
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days))
  return dt.toISOString().slice(0, 10)
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
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
