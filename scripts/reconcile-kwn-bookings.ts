// scripts/reconcile-kwn-bookings.ts
/**
 * Reconcile Verco Kwinana (KWN) bookings against the consolidated Kwinana
 * Airtable master ("Bookings All"), the same way the VV reconciliation works —
 * but matched on the EXACT booking reference (Verco `booking.ref` == master
 * `Booking_Ref`), because KWN properties carry no Airtable record id.
 *
 *   - dry-run (default): report the diff + per-class counts. No writes.
 *   - --apply: cancellations (Confirmed→Cancelled) + future→future reschedules.
 *     Status syncs to Completed/Non-conformance need the booking to be Scheduled
 *     first — KWN bookings are all Confirmed (the cron hasn't advanced them), so
 *     those are reported as blocked, not forced (illegal transition + Red Line #5).
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/reconcile-kwn-bookings.ts            # dry run
 *   npx tsx scripts/reconcile-kwn-bookings.ts --apply    # apply safe fixes
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import {
  reconcileByRef,
  buildActionPlan,
  countByClass,
  CLASS_ORDER,
  type Finding,
  type SourceBooking,
  type VercoBooking,
  type ActionPlan,
  type Action,
} from './lib/reconcile'

const KWN_BASE = 'apppzIjIc05ghcixH' // "Kwinana Pre-booked Verge Collection"
const BOOKINGS_ALL = 'tblthTRXTHTvUkxBk' // consolidated master
const WINDOW_BUFFER_DAYS = 21
const F = {
  ref: 'fldfuWaydRMJC4DCW',
  status: 'fld5vEwbAO4aCXmAf',
  collectionDate: 'fldIMEWF9CtNlNZ8v', // lookup: ["YYYY-MM-DD"]
  wasteLocation: 'fldRb7yyA6ShyYQAw',
  modifiedTime: 'flddX5vbMrzHbMufl',
} as const
const VALID_STATUSES = new Set(['Booked', 'Place Out Issued', 'Scheduled', 'Completed', 'Non-Conformance', 'Cancelled'])

async function main() {
  const apply = !!parseFlags(process.argv).apply
  const token = requireEnv('AIRTABLE_TOKEN')
  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  console.log(`Reconcile KWN bookings  (${apply ? 'APPLY' : 'DRY RUN'})`)

  const vercoBookings = await loadVerco(verco)
  console.log(`Verco: ${vercoBookings.length} KWN bookings.`)

  const dates = vercoBookings.map((b) => b.collectionDate).filter((d): d is string => !!d).sort()
  const windowStart = dates[0] ?? '2000-01-01'
  const windowEnd = addDays(dates[dates.length - 1] ?? '2100-01-01', WINDOW_BUFFER_DAYS)

  const all = await fetchSource(token)
  const source = all.filter((s) => s.collectionDate != null && s.collectionDate >= windowStart && s.collectionDate <= windowEnd)
  console.log(`Airtable "Bookings All": ${all.length} rows; ${source.length} dated + in window [${windowStart} … ${windowEnd}].`)

  const findings = reconcileByRef(vercoBookings, source, new Date())
  const counts = countByClass(findings)

  const stamp = timestamp()
  writeFileSync(`reconcile-kwn-report-${stamp}.json`, JSON.stringify({ counts, findings }, null, 2))
  writeCsv(findings, stamp)
  printSummary(counts, findings)

  const today = new Date().toISOString().slice(0, 10)
  const plan = buildActionPlan(findings, today)
  printPlan(plan, apply)
  if (apply) await executePlan(verco, plan)
  else console.log('\nDRY RUN — re-run with --apply to action the cancellations + reschedules.')
  console.log(`\nReport: reconcile-kwn-report-${stamp}.{json,csv}`)
}

// ─── Verco load ────────────────────────────────────────────────────────────────

async function loadVerco(verco: SupabaseClient): Promise<VercoBooking[]> {
  const { data: areas } = await verco.from('collection_area').select('id, code').like('code', 'KWN%')
  const areaCode = new Map((areas ?? []).map((a) => [a.id as string, a.code as string]))
  const areaIds = [...areaCode.keys()]

  const bookings = await pagedIn<{
    id: string
    ref: string
    status: string
    created_at: string
    location: string | null
    notes: string | null
    property_id: string | null
    collection_area_id: string
  }>(verco, 'booking', 'id, ref, status, created_at, location, notes, property_id, collection_area_id', 'collection_area_id', areaIds)

  const ids = bookings.map((b) => b.id)
  const propIds = uniq(bookings.map((b) => b.property_id).filter((x): x is string => !!x))
  const props = await pagedIn<{ id: string; address: string | null }>(verco, 'eligible_properties', 'id, address', 'id', propIds)
  const address = new Map(props.map((p) => [p.id, p.address]))

  const items = await pagedIn<{ booking_id: string; collection_date_id: string | null }>(
    verco,
    'booking_item',
    'booking_id, collection_date_id',
    'booking_id',
    ids,
  )
  const dateIds = uniq(items.map((i) => i.collection_date_id).filter((x): x is string => !!x))
  const cdates = await pagedIn<{ id: string; date: string }>(verco, 'collection_date', 'id, date', 'id', dateIds)
  const dateOf = new Map(cdates.map((d) => [d.id, d.date]))
  const minDate = new Map<string, string | null>()
  for (const it of items) {
    const d = it.collection_date_id ? dateOf.get(it.collection_date_id) ?? null : null
    const cur = minDate.get(it.booking_id) ?? null
    if (d && (!cur || d < cur)) minDate.set(it.booking_id, d)
    else if (!minDate.has(it.booking_id)) minDate.set(it.booking_id, cur)
  }

  const stops = await pagedIn<{ booking_id: string; pushed_at: string | null }>(verco, 'collection_stop', 'booking_id, pushed_at', 'booking_id', ids)
  const dispatched = new Set(stops.filter((s) => s.pushed_at != null).map((s) => s.booking_id))

  return bookings.map((b) => ({
    id: b.id,
    ref: b.ref,
    area: areaCode.get(b.collection_area_id) ?? 'KWN',
    address: (b.property_id ? address.get(b.property_id) : '') ?? '',
    propertyExternalId: null,
    location: b.location ?? null,
    notes: b.notes ?? null,
    collectionDate: minDate.get(b.id) ?? null,
    status: b.status,
    importedAt: b.created_at,
    bulkCount: 0,
    greenCount: 0,
    mattressCount: 0,
    isDispatched: dispatched.has(b.id),
  }))
}

// ─── Airtable master fetch ──────────────────────────────────────────────────────

async function fetchSource(token: string): Promise<SourceBooking[]> {
  const out: SourceBooking[] = []
  let offset: string | undefined
  do {
    const params = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' })
    for (const id of Object.values(F)) params.append('fields[]', id)
    if (offset) params.set('offset', offset)
    const res = await fetch(`https://api.airtable.com/v0/${KWN_BASE}/${BOOKINGS_ALL}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Airtable HTTP ${res.status}`)
    const body = (await res.json()) as { records: Array<{ fields: Record<string, unknown> }>; offset?: string }
    for (const rec of body.records) {
      const f = rec.fields
      const status = f[F.status] as string | undefined
      const ref = f[F.ref] as string | undefined
      if (!ref || !status || !VALID_STATUSES.has(status)) continue
      out.push({
        recordId: ref,
        bookingRef: String(ref),
        propertyRecId: '',
        collectionDate: (f[F.collectionDate] as string[] | undefined)?.[0] ?? null,
        status: status as SourceBooking['status'],
        noBulk: 0,
        noGreen: 0,
        noMattress: 0,
        wasteLocation: (f[F.wasteLocation] as string | undefined) ?? null,
        wasteNotes: null, // KWN "Bookings All" has no Waste_Notes field; note-fill is VV-scoped.
        modifiedAt: String(f[F.modifiedTime] ?? ''),
      })
    }
    offset = body.offset
  } while (offset)
  return out
}

// ─── Report + apply ─────────────────────────────────────────────────────────────

function printSummary(counts: Record<string, number>, findings: Finding[]) {
  console.log('\n═════════ Reconciliation summary ═════════')
  for (const c of CLASS_ORDER) console.log(`  ${c.padEnd(22)} ${counts[c] ?? 0}`)
  console.log(`  ${'TOTAL'.padEnd(22)} ${findings.length}`)
}

function printPlan(plan: ActionPlan, apply: boolean) {
  const n = (k: Action['kind']) => plan.actions.filter((a) => a.kind === k).length
  console.log(`\n═════════ Action plan (${apply ? 'APPLYING' : 'DRY RUN'}) ═════════`)
  console.log(`  cancel                 ${n('cancel')}`)
  console.log(`  reschedule (fut→fut)   ${n('reschedule')}`)
  console.log(`  fix waste location     ${n('location')}`)
  console.log('  ─ skipped (a rule blocks them) ─')
  console.log(`  status change blocked  ${plan.skipped.statusChangeBlocked}   (master Completed/NC but Verco still Confirmed — illegal transition)`)
  console.log(`  Place Out→Scheduled    ${plan.skipped.placeOutToScheduled}   (Red Line #5 — the cron owns Confirmed→Scheduled)`)
  console.log(`  dispatched reschedule  ${plan.skipped.dispatchedReschedule}`)
  console.log(`  reactivate cancelled   ${plan.skipped.reactivateCancelled}`)
}

async function executePlan(verco: SupabaseClient, plan: ActionPlan) {
  const fail: { ref: string; kind: string; error: string }[] = []
  const done: Record<string, number> = {}
  const now = new Date().toISOString()
  for (const a of plan.actions) {
    let error: string | null = null
    if (a.kind === 'cancel') {
      const r = await verco
        .from('booking')
        .update({ status: 'Cancelled', cancelled_at: now, cancellation_reason: `Reconciliation: cancelled in Kwinana master (${a.masterRef})` })
        .eq('id', a.bookingId)
      error = r.error?.message ?? null
    } else if (a.kind === 'status') {
      error = (await verco.from('booking').update({ status: a.to }).eq('id', a.bookingId)).error?.message ?? null
    } else if (a.kind === 'location') {
      error = (await verco.from('booking').update({ location: a.to }).eq('id', a.bookingId)).error?.message ?? null
    } else if (a.kind === 'reschedule') {
      const { data: b } = await verco.from('booking').select('collection_area_id').eq('id', a.bookingId).single()
      const { data: cd } = await verco
        .from('collection_date')
        .select('id')
        .eq('collection_area_id', b!.collection_area_id)
        .eq('date', a.to)
        .maybeSingle()
      if (!cd) error = `no collection_date row for ${a.to}`
      else error = (await verco.from('booking_item').update({ collection_date_id: cd.id }).eq('booking_id', a.bookingId)).error?.message ?? null
    }
    if (error) fail.push({ ref: a.ref, kind: a.kind, error })
    else done[a.kind] = (done[a.kind] ?? 0) + 1
  }
  console.log('\n─ applied ─')
  for (const [k, v] of Object.entries(done)) console.log(`  ${k}: ${v}`)
  for (const f of fail) console.error(`  ✗ ${f.ref} (${f.kind}): ${f.error}`)
}

function writeCsv(findings: Finding[], stamp: string) {
  const rows = [...findings].sort((a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class))
  const header = 'class,verco_ref,area,verco_status,source_status,verco_date,source_date,modified_at,proposed_action'
  const body = rows.map((f) =>
    [
      f.class,
      f.verco?.ref ?? f.source?.bookingRef ?? '',
      f.verco?.area ?? '',
      f.verco?.status ?? '',
      f.source?.status ?? '',
      f.verco?.collectionDate ?? '',
      f.source?.collectionDate ?? '',
      f.source?.modifiedAt?.slice(0, 10) ?? '',
      f.proposedAction,
    ]
      .map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
      .join(','),
  )
  writeFileSync(`reconcile-kwn-report-${stamp}.csv`, [header, ...body].join('\n'))
}

// ─── helpers ─────────────────────────────────────────────────────────────────

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

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10)
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
