// scripts/import-vv-surveys-csv.ts
/**
 * Import Verge Valet resident surveys from the Airtable `Survey` table CSV
 * export into `booking_survey`, so the admin Surveys page and the Reports
 * CSAT series carry each council's history across its cutover.
 *
 * Requires migration 20260823200000_booking_survey_legacy_import (nullable
 * booking_id, collection_area_id, source, external_ref).
 *
 * Per row (Council in --councils):
 *   - collection_area_id  ← Council code (MOS/COT/PEP/VIN …)
 *   - booking_id          ← Booking_Ref when that booking exists in Verco and
 *                           has no submitted survey yet (an unsubmitted invite
 *                           row is filled in place instead of inserted)
 *   - source/external_ref ← 'airtable' / `${Booking_Ref}|${Create Date}`
 *                           (idempotency key — Row ID is empty in the export)
 *   - submitted_at, created_at ← Create Date (Australia/Perth)
 *   - responses           ← the shipped question keys (src/lib/survey/questions.ts)
 *                           plus flat `legacy_*` keys for anything that has no
 *                           1:1 home; the detail page renders unknown flat keys
 *                           in its "Legacy" block. No contact PII is carried.
 *
 * Usage:
 *   set -a; . .env.local; set +a
 *   npx tsx scripts/import-vv-surveys-csv.ts --file="Survey.csv" --councils=MOS,COT,PEP,VIN          # dry run
 *   npx tsx scripts/import-vv-surveys-csv.ts --file="Survey.csv" --councils=MOS,COT,PEP,VIN --apply
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import { parseCsv, type CsvRow } from './lib/csv'
import { pagedIn } from './lib/db'
import { timestamp } from './lib/report'

const PERTH_OFFSET = '+08:00' // WA has no DST

export type Responses = Record<string, string | number>
export type ParsedSurvey = {
  externalRef: string
  council: string
  bookingRef: string | null
  submittedAt: string | null // ISO UTC
  responses: Responses
  hasRating: boolean
}

/** Airtable "8/22/2026 8:33pm" (Perth local) → ISO UTC, or null. */
export function parseAirtableDateTime(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(am|pm)$/i.exec(s.trim())
  if (!m) return null
  let h = Number(m[4]) % 12
  if (m[6]!.toLowerCase() === 'pm') h += 12
  const iso = `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}T${String(h).padStart(2, '0')}:${m[5]}:00${PERTH_OFFSET}`
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** "5.00" → 5; anything outside 1..5 integers → null (the RPC regex is ^[1-5]$). */
export function parseRating(s: string): number | null {
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 5) return null
  return n
}

const REPAIR: Record<string, string> = { yes: 'Yes — attempted repair', no: 'No' }
const SELL_ONLINE = ['facebook marketplace', 'gumtree / ebay', 'garage sale']
const SELL_FAMILY = 'friends/family/neighbours'

export function mapAttemptedSell(attemptToMove: string): string | null {
  const opts = attemptToMove.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
  if (opts.some((o) => SELL_ONLINE.includes(o))) return 'Yes — sold online (e.g. Facebook Marketplace)'
  if (opts.includes(SELL_FAMILY)) return 'Yes — gave to family/friends'
  return null
}

export function parseSurveyRow(r: CsvRow): ParsedSurvey {
  const responses: Responses = {}
  const put = (k: string, v: string | number | null | undefined) => { if (v !== null && v !== undefined && v !== '') responses[k] = v }
  const br = parseRating(r['Booking Rating'] ?? ''), cr = parseRating(r['Collection Rating'] ?? ''), or = parseRating(r['Overall Rating'] ?? '')
  put('booking_rating', br); put('collection_rating', cr); put('overall_rating', or)
  put('booking_comments', r['Booking Comments']); put('collection_comments', r['Collection Comments']); put('other_comments', r['Other Comments'])
  const prefer = (r['Prefer VV'] ?? '').trim()
  if (['Yes', 'No', 'Indifferent'].includes(prefer)) put('prefer_service', prefer)
  put('attempted_repair', REPAIR[(r['Attempt to Repair'] ?? '').trim().toLowerCase()])
  put('attempted_sell', mapAttemptedSell(r['Attempt to Move'] ?? ''))
  put('legacy_services_used', r['Services Used'])
  put('legacy_attempt_to_move', r['Attempt to Move'])
  put('legacy_attempt_to_repair', r['Attempt to Repair'])
  put('legacy_sentiment_ai', r['Sentiment AI'])
  put('legacy_ranking_sentiment', r['Ranking Sentiment'])
  const bookingRef = (r['Booking_Ref'] ?? '').trim() || null
  const created = (r['Create Date'] ?? '').trim()
  return {
    externalRef: `${bookingRef ?? ''}|${created}`,
    council: (r['Council'] ?? '').trim().toUpperCase(),
    bookingRef,
    submittedAt: parseAirtableDateTime(created),
    responses,
    hasRating: br !== null || cr !== null || or !== null,
  }
}

/** Airtable double-submits (same ref, same minute) share an external_ref — keep the first. */
export function dedupeByExternalRef<T extends { externalRef: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter((r) => (seen.has(r.externalRef) ? false : (seen.add(r.externalRef), true)))
}

async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const file = typeof flags.file === 'string' ? flags.file : null
  const councils = typeof flags.councils === 'string' ? flags.councils.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : []
  if (!file || councils.length === 0) { console.error('Usage: --file=<csv> --councils=MOS,COT [--apply]'); process.exit(1) }
  const unknown = Object.keys(flags).filter((k) => !['apply', 'file', 'councils'].includes(k))
  if (unknown.length) { console.error(`Unknown flag(s): ${unknown.join(', ')}`); process.exit(1) }

  const verco = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  console.log(`Import VV surveys CSV → ${councils.join(',')}  (${apply ? 'APPLY' : 'DRY RUN'})`)

  const { data: client } = await verco.from('client').select('id').eq('slug', 'vergevalet').single()
  if (!client) throw new Error('vergevalet client not found')
  const { data: areas } = await verco.from('collection_area').select('id, code').eq('client_id', client.id).in('code', councils)
  const areaByCode = new Map((areas ?? []).map((a) => [a.code as string, a.id as string]))
  const missingArea = councils.filter((c) => !areaByCode.has(c))
  if (missingArea.length) throw new Error(`No collection_area for: ${missingArea.join(', ')}`)

  const all = parseCsv(readFileSync(file, 'utf8')).map(parseSurveyRow)
  const inScope = all.filter((p) => councils.includes(p.council))
  const unknownCouncil = all.filter((p) => !councils.includes(p.council)).reduce<Record<string, number>>((m, p) => ((m[p.council || '(blank)'] = (m[p.council || '(blank)'] ?? 0) + 1), m), {})
  // Airtable double-submits (same ref, same minute) share an external_ref —
  // keep the first so the plan count matches what the partial UNIQUE admits.
  const rows = dedupeByExternalRef(inScope)
  console.log(`CSV rows: ${all.length}; in ${councils.join('/')}: ${inScope.length} (${inScope.length - rows.length} exact duplicate submissions dropped)`)

  // Existing state: legacy refs already imported, bookings by ref, surveys by booking.
  const existing = await pagedIn<{ id: string; external_ref: string | null; booking_id: string | null; submitted_at: string | null }>(
    verco, 'booking_survey', 'id, external_ref, booking_id, submitted_at', 'client_id', [client.id as string],
  )
  const importedRefs = new Set(existing.map((e) => e.external_ref).filter((x): x is string => !!x))
  const surveyByBooking = new Map(existing.filter((e) => e.booking_id).map((e) => [e.booking_id as string, e]))
  const wantedRefs = [...new Set(rows.map((p) => p.bookingRef).filter((x): x is string => !!x))]
  const bookings = wantedRefs.length
    ? await pagedIn<{ id: string; ref: string; collection_area_id: string }>(verco, 'booking', 'id, ref, collection_area_id', 'ref', wantedRefs)
    : []
  const bookingByRef = new Map(bookings.map((b) => [b.ref, b]))

  type Plan = { p: ParsedSurvey; areaId: string; bookingId: string | null; fillSurveyId: string | null }
  const plans: Plan[] = []
  // Spec: a booking that already has a submitted Verco survey, or whose area
  // disagrees with the CSV council, is SKIPPED and reported — never imported
  // unlinked (that would be a second survey for the same collection).
  const skip = { already_imported: 0, no_rating: 0, bad_date: 0, booking_has_submitted_survey: [] as string[], booking_area_mismatch: [] as string[] }
  const usedBookings = new Set<string>()
  for (const p of rows) {
    if (importedRefs.has(p.externalRef)) { skip.already_imported++; continue }
    if (!p.hasRating) { skip.no_rating++; continue }
    if (!p.submittedAt) { skip.bad_date++; continue }
    const areaId = areaByCode.get(p.council)!
    let bookingId: string | null = null, fillSurveyId: string | null = null
    const b = p.bookingRef ? bookingByRef.get(p.bookingRef) : undefined
    if (b && !usedBookings.has(b.id)) {
      if (b.collection_area_id !== areaId) { skip.booking_area_mismatch.push(p.bookingRef!); continue }
      const ex = surveyByBooking.get(b.id)
      if (ex?.submitted_at) { skip.booking_has_submitted_survey.push(p.bookingRef!); continue }
      bookingId = b.id; fillSurveyId = ex?.id ?? null; usedBookings.add(b.id)
    }
    plans.push({ p, areaId, bookingId, fillSurveyId })
  }

  const byCouncil = plans.reduce<Record<string, number>>((m, x) => ((m[x.p.council] = (m[x.p.council] ?? 0) + 1), m), {})
  const stamp = timestamp()
  const reportPath = `import-vv-surveys-report-${stamp}.json`
  writeFileSync(reportPath, JSON.stringify({ councils, apply, byCouncil, plans: plans.map((x) => ({ ref: x.p.externalRef, council: x.p.council, linked: !!x.bookingId, fill: x.fillSurveyId, submittedAt: x.p.submittedAt })), skip }, null, 2))
  console.log('\n═════════ Import plan ═════════')
  console.log(`  would import:                   ${plans.length}   ${JSON.stringify(byCouncil)}`)
  console.log(`    linked to a Verco booking:    ${plans.filter((x) => x.bookingId).length} (${plans.filter((x) => x.fillSurveyId).length} fill an unsubmitted invite)`)
  console.log(`  not in --councils (ignored):    ${JSON.stringify(unknownCouncil)}`)
  console.log(`  skip · already imported         ${skip.already_imported}`)
  console.log(`  skip · no valid rating          ${skip.no_rating}`)
  console.log(`  skip · unparseable date         ${skip.bad_date}`)
  console.log(`  skip · booking already has a submitted survey: ${skip.booking_has_submitted_survey.length}`)
  console.log(`  skip · booking in a different area:            ${skip.booking_area_mismatch.length}`)
  console.log(`  report: ${reportPath}`)
  if (!apply) { console.log(`\nDRY RUN — re-run with --apply to import ${plans.length} surveys.`); return }

  let done = 0
  const fail: { ref: string; error: string }[] = []
  for (const pl of plans) {
    try {
      if (pl.fillSurveyId) {
        const { error } = await verco.from('booking_survey')
          .update({ responses: pl.p.responses, submitted_at: pl.p.submittedAt, created_at: pl.p.submittedAt, source: 'airtable', external_ref: pl.p.externalRef })
          .eq('id', pl.fillSurveyId)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await verco.from('booking_survey').insert({
          client_id: client.id, collection_area_id: pl.areaId, booking_id: pl.bookingId,
          source: 'airtable', external_ref: pl.p.externalRef, token: randomUUID(),
          submitted_at: pl.p.submittedAt, created_at: pl.p.submittedAt, responses: pl.p.responses,
        })
        if (error) throw new Error(error.message)
      }
      done++
    } catch (e) { fail.push({ ref: pl.p.externalRef, error: (e as Error).message }) }
  }
  console.log(`\nImported ${done}/${plans.length} surveys.`)
  for (const f of fail) console.error(`  ✗ ${f.ref}: ${f.error}`)
  if (fail.length) process.exit(1)
}

if (process.argv[1]?.endsWith('import-vv-surveys-csv.ts')) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1) })
}
