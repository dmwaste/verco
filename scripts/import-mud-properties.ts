// scripts/import-mud-properties.ts
/**
 * Airtable MUD List → Verco migration.
 *
 * Imports 365 MUD strata complexes from tblmKPAzNLWyJoztY (main VV base)
 * into eligible_properties (MUD columns), contacts, and mud-auth-forms storage.
 *
 * Pass 1 — upsert properties + contacts (no auth_form_url yet).
 * Pass 2 — download auth forms from Airtable, upload to Supabase Storage,
 *           patch auth_form_url + upgrade status to Registered where eligible.
 *
 * Idempotent: external_source='airtable-mud', external_id=<Airtable record ID>.
 * Re-runs update existing rows; contact upsert is idempotent on email.
 *
 * Usage:
 *   pnpm tsx scripts/import-mud-properties.ts            # full import
 *   pnpm tsx scripts/import-mud-properties.ts --dry-run  # no writes
 *   pnpm tsx scripts/import-mud-properties.ts --skip-forms
 *   pnpm tsx scripts/import-mud-properties.ts --limit=10
 */
import { createClient } from '@supabase/supabase-js'  // keep for verco client creation
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fetchAllMudRecords } from './lib/airtable-mud'
import { loadAreaMap, resolveAreaId } from './lib/area-map'
import { upsertEligibleProperties } from './lib/verco-upsert'
import { upsertContact } from './lib/contact-upsert'
import { parseFlags, requireEnv } from './lib/cli'
import type { AirtableMudRecord, MudPropertyInsert } from './lib/types'

const EXTERNAL_SOURCE = 'airtable-mud'
const STORAGE_BUCKET = 'mud-auth-forms'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalisePhone(raw: string | null): string {
  if (!raw?.trim()) return ''
  const s = raw.replace(/[\s\-()+.]/g, '').replace(/^\+/, '')
  // Already started with +61 → re-add
  if (raw.trimStart().startsWith('+61')) return `+61${s.slice(2)}`
  if (raw.trimStart().startsWith('+')) return `+${s}`
  // 8-digit landline without leading 0 (e.g. "93827700") → Perth +618
  if (/^\d{8}$/.test(s)) return `+618${s}`
  // 10-digit starting with 0 (mobile 04xx / landline 08xx)
  if (s.startsWith('0') && s.length === 10) return `+61${s.slice(1)}`
  // Fallback: store as-is (flagged in report)
  return raw.trim()
}

function splitName(raw: string | null): { firstName: string; lastName: string } {
  if (!raw?.trim()) return { firstName: '', lastName: '' }
  const trimmed = raw.trim()
  const idx = trimmed.indexOf(' ')
  if (idx === -1) return { firstName: trimmed, lastName: '' }
  return { firstName: trimmed.slice(0, idx), lastName: trimmed.slice(idx + 1) }
}

function toCadence(months: number): 'Ad-hoc' | 'Annual' | 'Bi-annual' | 'Quarterly' {
  if (months === 12) return 'Annual'
  if (months === 6) return 'Bi-annual'
  if (months === 3 || months === 2) return 'Quarterly'
  return 'Ad-hoc'
}

function buildNotes(raw: string | null, offStreet: boolean): string | null {
  const parts: string[] = []
  if (raw?.trim()) parts.push(raw.trim())
  if (offStreet) parts.push('Off-street collection agreed.')
  return parts.length > 0 ? parts.join('\n') : null
}

function isStubRecord(rec: AirtableMudRecord): boolean {
  return !rec.address.trim() && !rec.mudRef
}

function timestamp(): string {
  const d = new Date()
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseFlags(process.argv)
  const dryRun = !!flags['dry-run']
  const skipForms = !!flags['skip-forms']
  const limit = typeof flags.limit === 'string' ? Number(flags.limit) : null

  const airtableToken = requireEnv('AIRTABLE_TOKEN')
  const supabaseUrl   = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey    = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

  const verco = createClient(supabaseUrl, serviceKey)

  // ── Load area map ──
  const areaMap = await loadAreaMap(verco)
  console.log(`Loaded ${areaMap.size} Verco collection_areas for vergevalet.`)

  // ── Fetch MUD records ──
  console.log('\nFetching MUD List from Airtable…')
  let records = await fetchAllMudRecords(airtableToken)
  if (limit) records = records.slice(0, limit)
  console.log(`Fetched ${records.length} records.`)

  // ── Diagnostic counters ──
  const report: {
    completedAt: string
    dryRun: boolean
    skipForms: boolean
    totalFetched: number
    skippedStubs: string[]
    unmappedCodes: Array<{ id: string; address: string; code: string | null }>
    cadenceApproximate: Array<{ id: string; address: string; frequencyMonths: number; mappedTo: string }>
    duplicateMudCode: Array<{ id: string; address: string; mudRef: string; clearedTo: null }>
    noPhoneContact: Array<{ id: string; address: string }>
    contactsCreated: number
    contactErrors: Array<{ id: string; address: string; error: string }>
    propertiesUpserted: number
    failedBatches: number
    formsUploaded: number
    formsSkipped: number
    formsFailed: Array<{ id: string; address: string; error: string }>
    statusUpgradedToRegistered: Array<{ id: string; address: string }>
  } = {
    completedAt: '',
    dryRun,
    skipForms,
    totalFetched: records.length,
    skippedStubs: [],
    unmappedCodes: [],
    cadenceApproximate: [],
    duplicateMudCode: [],
    noPhoneContact: [],
    contactsCreated: 0,
    contactErrors: [],
    propertiesUpserted: 0,
    failedBatches: 0,
    formsUploaded: 0,
    formsSkipped: 0,
    formsFailed: [],
    statusUpgradedToRegistered: [],
  }

  // ── Pass 1: build + upsert properties ──
  console.log('\nPass 1 — building property rows…')
  const insertable: MudPropertyInsert[] = []

  // Track records that should be upgraded to Registered in pass 2
  // (has contact, has notes, has auth form in Airtable)
  const registeredCandidates = new Set<string>()

  // Deduplicate on (collection_area_id, mud_code) — constraint is partial (WHERE mud_code IS NOT NULL)
  // When a duplicate is found, nullify mud_code on the second occurrence and flag for manual review.
  const seenMudCodes = new Set<string>()

  for (const rec of records) {
    // Skip stubs
    if (isStubRecord(rec)) {
      report.skippedStubs.push(`${rec.id} "${rec.address}"`)
      continue
    }

    // Resolve area
    const areaId = rec.councilCodeName ? resolveAreaId(rec.councilCodeName, areaMap) : null
    if (!areaId) {
      report.unmappedCodes.push({ id: rec.id, address: rec.address, code: rec.councilCodeName })
      continue
    }

    // Preserve raw unit count from Airtable — 0 means "not yet recorded"
    const unitCount = rec.units

    // Cadence
    const cadence = toCadence(rec.frequencyMonths)
    if (rec.frequencyMonths === 2) {
      report.cadenceApproximate.push({
        id: rec.id,
        address: rec.address,
        frequencyMonths: rec.frequencyMonths,
        mappedTo: cadence,
      })
    }

    // Contact
    if (!rec.contactNumber?.trim() && rec.email) {
      report.noPhoneContact.push({ id: rec.id, address: rec.address })
    }

    const { firstName, lastName } = splitName(rec.contactName)
    const mobile = normalisePhone(rec.contactNumber)
    const { contactId, created, error: contactError } = await upsertContact(
      verco,
      { email: rec.email, firstName, lastName, mobileE164: mobile },
      dryRun,
    )
    if (contactError) {
      report.contactErrors.push({ id: rec.id, address: rec.address, error: contactError })
    }
    if (created) report.contactsCreated++

    // Dedup mud_code within the same area (partial unique index)
    let mudRef = rec.mudRef
    if (mudRef && areaId) {
      const mudKey = `${areaId}::${mudRef}`
      if (seenMudCodes.has(mudKey)) {
        report.duplicateMudCode.push({ id: rec.id, address: rec.address, mudRef, clearedTo: null })
        mudRef = null
      } else {
        seenMudCodes.add(mudKey)
      }
    }

    // Notes
    const notes = buildNotes(rec.notes, rec.offStreetAgreed)

    // Status — conservative in pass 1 (Registered requires form upload to succeed)
    const airtableStatus = rec.status?.trim() ?? null
    let status: 'Contact Made' | 'Registered' | 'Inactive' = 'Contact Made'
    if (airtableStatus === 'Inactive') {
      status = 'Inactive'
    } else if (airtableStatus === 'Registered' && contactId && notes && rec.authFormUrl) {
      // Mark as candidate — will upgrade to Registered after form upload in pass 2
      registeredCandidates.add(rec.id)
      // Leave as Contact Made for now
    }

    insertable.push({
      collection_area_id: areaId,
      address: rec.address,
      formatted_address: null,
      latitude: null,
      longitude: null,
      google_place_id: null,
      has_geocode: false,
      is_mud: true,
      external_source: EXTERNAL_SOURCE,
      external_id: rec.id,
      unit_count: unitCount,
      mud_code: mudRef,
      mud_onboarding_status: status,
      collection_cadence: cadence,
      waste_location_notes: notes,
      strata_contact_id: contactId,
    })
  }

  console.log(`  Prepared ${insertable.length} rows (${report.skippedStubs.length} stubs skipped, ${report.unmappedCodes.length} unmapped codes skipped).`)

  if (!dryRun && insertable.length > 0) {
    const result = await upsertEligibleProperties(verco, insertable, (done, total) => {
      process.stdout.write(`\r  Upserting… ${done}/${total}`)
    })
    process.stdout.write('\n')
    report.propertiesUpserted = result.ok
    report.failedBatches = result.failedBatches
  } else if (dryRun) {
    console.log(`  DRY RUN — would upsert ${insertable.length} rows.`)
    report.propertiesUpserted = 0
  }

  // ── Pass 2: auth form upload ──
  if (skipForms || dryRun) {
    const reason = dryRun ? 'dry-run' : '--skip-forms'
    console.log(`\nPass 2 — skipped (${reason}).`)
    report.formsSkipped = records.filter((r) => r.authFormUrl).length
  } else {
    const withForms = records.filter(
      (r) => r.authFormUrl && !isStubRecord(r) && !report.unmappedCodes.find((u) => u.id === r.id),
    )
    console.log(`\nPass 2 — uploading ${withForms.length} auth forms…`)

    for (const rec of withForms) {
      process.stdout.write(`\r  ${report.formsUploaded + report.formsFailed.length + 1}/${withForms.length} ${rec.mudRef ?? rec.id}   `)

      // Get the real property UUID (upserted in pass 1)
      const { data: prop, error: propErr } = await verco
        .from('eligible_properties')
        .select('id, collection_area_id')
        .eq('external_source', EXTERNAL_SOURCE)
        .eq('external_id', rec.id)
        .single()

      if (propErr || !prop) {
        report.formsFailed.push({ id: rec.id, address: rec.address, error: propErr?.message ?? 'Property not found after upsert' })
        continue
      }

      // Download from Airtable (signed URL — expiring)
      let fileBuffer: Buffer
      try {
        const dlRes = await fetch(rec.authFormUrl!)
        if (!dlRes.ok) throw new Error(`HTTP ${dlRes.status}`)
        fileBuffer = Buffer.from(await dlRes.arrayBuffer())
      } catch (err) {
        report.formsFailed.push({ id: rec.id, address: rec.address, error: `Download failed: ${(err as Error).message}` })
        continue
      }

      // Upload to Storage
      const filename = rec.authFormFilename ?? 'form.pdf'
      const storagePath = `${prop.collection_area_id}/${prop.id}/${randomUUID()}-${filename}`
      const { error: uploadErr } = await verco.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, fileBuffer, {
          contentType: filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
          upsert: true,
        })

      if (uploadErr) {
        report.formsFailed.push({ id: rec.id, address: rec.address, error: `Upload failed: ${uploadErr.message}` })
        continue
      }

      // Patch auth_form_url + possibly upgrade status to Registered
      const shouldUpgrade = registeredCandidates.has(rec.id)
      const patch: Record<string, string> = { auth_form_url: storagePath }
      if (shouldUpgrade) patch.mud_onboarding_status = 'Registered'

      const { error: patchErr } = await verco
        .from('eligible_properties')
        .update(patch)
        .eq('id', prop.id as string)

      if (patchErr) {
        report.formsFailed.push({ id: rec.id, address: rec.address, error: `Patch failed: ${patchErr.message}` })
        continue
      }

      report.formsUploaded++
      if (shouldUpgrade) report.statusUpgradedToRegistered.push({ id: rec.id, address: rec.address })
    }
    process.stdout.write('\n')
  }

  // ── Write report ──
  report.completedAt = new Date().toISOString()
  const reportPath = `import-mud-report-${timestamp()}.json`
  writeFileSync(reportPath, JSON.stringify(report, null, 2))

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log(`Done.${dryRun ? ' (DRY RUN — no writes)' : ''}`)
  console.log(`  Fetched:            ${report.totalFetched}`)
  console.log(`  Stubs skipped:      ${report.skippedStubs.length}`)
  console.log(`  Unmapped codes:     ${report.unmappedCodes.length}`)
  console.log(`  Cadence approx:     ${report.cadenceApproximate.length} (freq=2 → Quarterly)`)
  console.log(`  Duplicate mud_code: ${report.duplicateMudCode.length} (mud_code nullified — manual review)`)
  console.log(`  Contacts created:   ${report.contactsCreated}`)
  console.log(`  Contact errors:     ${report.contactErrors.length}`)
  console.log(`  Properties upserted:${report.propertiesUpserted}  (failedBatches=${report.failedBatches})`)
  console.log(`  Forms uploaded:     ${report.formsUploaded}`)
  console.log(`  Forms skipped:      ${report.formsSkipped}`)
  console.log(`  Forms failed:       ${report.formsFailed.length}`)
  console.log(`  Status → Registered:${report.statusUpgradedToRegistered.length}`)
  console.log(`  Report:             ${reportPath}`)

  if (report.unmappedCodes.length > 0) {
    console.log('\n⚠  Unmapped council codes (records skipped):')
    for (const u of report.unmappedCodes) {
      console.log(`    ${u.id}  code="${u.code}"  "${u.address}"`)
    }
  }

  if (report.duplicateMudCode.length > 0) {
    console.log('\n⚠  Duplicate mud_code cleared (mud_code set to null — assign manually in admin UI):')
    for (const d of report.duplicateMudCode) {
      console.log(`    ${d.id}  code="${d.mudRef}"  "${d.address}"`)
    }
  }

  if (report.contactErrors.length > 0) {
    console.log('\n⚠  Contact errors:')
    for (const e of report.contactErrors) {
      console.log(`    ${e.id}  ${e.error}`)
    }
  }

  if (report.formsFailed.length > 0) {
    console.log('\n⚠  Form upload failures:')
    for (const f of report.formsFailed) {
      console.log(`    ${f.id}  ${f.error}  "${f.address}"`)
    }
  }

  console.log('')
  console.log('Verification queries:')
  console.log("  SELECT mud_onboarding_status, collection_cadence, count(*)")
  console.log("  FROM eligible_properties WHERE external_source = 'airtable-mud'")
  console.log("  GROUP BY mud_onboarding_status, collection_cadence ORDER BY 1, 2;")
  console.log('')
  console.log("  SELECT count(*) FROM eligible_properties ep")
  console.log("  JOIN contacts c ON c.id = ep.strata_contact_id")
  console.log("  WHERE ep.external_source = 'airtable-mud';")
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
