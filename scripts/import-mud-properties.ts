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
 *   --base=appIgPfNX8SYS9QIq   read a council's OWN base (SUB/VIC were duplicated
 *                              from the main base: same table + field ids)
 *   --geocode                  after the upsert, geocode rows still without a
 *                              geocode via the geocode-properties EF
 *
 * ⚠ Writes by default — pass --dry-run first. Pass 1 re-upserts whole rows
 * (geocode → NULL, status → Contact Made): for rows already in Verco use --only
 * or --forms-only (see #460), or attach-mud-strata-contacts.ts for contacts.
 */
import { createClient } from '@supabase/supabase-js'  // keep for verco client creation
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fetchAllMudRecords, MUD_BASE_ID } from './lib/airtable-mud'
import { loadAreaMap, resolveAreaId } from './lib/area-map'
import { upsertEligibleProperties } from './lib/verco-upsert'
import { mudContactInput, upsertContact } from './lib/contact-upsert'
import { parseFlags, requireEnv } from './lib/cli'
import { timestamp } from './lib/report'
import type { AirtableMudRecord, MudPropertyInsert } from './lib/types'

const EXTERNAL_SOURCE = 'airtable-mud'
const STORAGE_BUCKET = 'mud-auth-forms'

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseFlags(process.argv)
  const dryRun = !!flags['dry-run']
  const skipForms = !!flags['skip-forms']
  const limit = typeof flags.limit === 'string' ? Number(flags.limit) : null
  // #460 targeted re-run flags. --only=recA,recB limits the run to specific
  // Airtable record ids. --forms-only skips Pass 1 entirely — CRITICAL for
  // rows that already exist in Verco: the Pass-1 upsert payload carries
  // formatted_address/lat/lng NULL + has_geocode=false + status='Contact
  // Made', so re-upserting an existing row would wipe its geocode and revert
  // curated fields. Forms-only also never patches mud_onboarding_status (the
  // Registered CHECK needs Verco-side contact+notes this mode doesn't sync).
  const only = typeof flags.only === 'string'
    ? new Set(flags.only.split(',').map((s) => s.trim()).filter(Boolean))
    : null
  const formsOnly = !!flags['forms-only']
  const base = typeof flags.base === 'string' ? flags.base : MUD_BASE_ID
  if (!/^app[A-Za-z0-9]{14}$/.test(base)) { console.error(`--base must be an Airtable base id, got "${base}"`); process.exit(1) }
  const geocode = !!flags.geocode

  const airtableToken = requireEnv('AIRTABLE_TOKEN')
  const supabaseUrl   = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey    = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

  const verco = createClient(supabaseUrl, serviceKey)

  // ── Load area map ──
  const areaMap = await loadAreaMap(verco)
  console.log(`Loaded ${areaMap.size} Verco collection_areas for vergevalet.`)

  // ── Fetch MUD records ──
  console.log(`\nFetching MUD List from Airtable base ${base}…${dryRun ? '  (DRY RUN)' : ''}`)
  let records = await fetchAllMudRecords(airtableToken, base)
  if (only) {
    records = records.filter((r) => only.has(r.id))
    console.log(`--only: narrowed to ${records.length}/${only.size} requested record(s).`)
  }
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
  const insertable: MudPropertyInsert[] = []
  // Hoisted above the --forms-only guard: Pass 2 reads registeredCandidates
  // (empty in forms-only mode, so no status upgrades there by construction).
  const registeredCandidates = new Set<string>()
  const seenMudCodes = new Set<string>()
  if (formsOnly) {
    console.log('\nPass 1 — skipped (--forms-only).')
  } else {
  console.log('\nPass 1 — building property rows…')

  // registeredCandidates: records to upgrade to Registered in pass 2
  // (has contact, has notes, has auth form in Airtable).
  // seenMudCodes: dedup on (collection_area_id, mud_code) — partial unique
  // index; duplicates get mud_code nullified + flagged for manual review.
  // Both declared above the --forms-only guard.

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

    const { contactId, created, error: contactError } = await upsertContact(verco, mudContactInput(rec), dryRun)
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

    // Status — defaults to Contact Made; Pass 2 flips eligible rows to Registered
    // after the form lands in Storage (the Registered CHECK needs auth_form_url).
    const airtableStatus = rec.status?.trim() ?? null
    let status: 'Contact Made' | 'Registered' | 'Inactive' = 'Contact Made'
    if (airtableStatus === 'Inactive') {
      status = 'Inactive'
    } else if (contactId && notes && rec.authFormUrl) {
      // Promote on completeness (Dan 22/06): a signed form + strata contact +
      // waste-location notes = onboarded, regardless of the Airtable "Status"
      // field (WMRC left most records at "Contact Made"). Without this, a re-run
      // would revert manually-promoted MUDs back to Contact Made.
      registeredCandidates.add(rec.id)
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
  } // end !formsOnly (Pass 1)

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

      // Patch auth_form_url + possibly upgrade status to Registered.
      // Never upgrade in --forms-only mode: the Registered CHECK requires
      // Verco-side contact + notes that this mode deliberately doesn't sync.
      const shouldUpgrade = !formsOnly && registeredCandidates.has(rec.id)
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

  // ── Geocode (opt-in) — Pass 1 inserts rows with has_geocode=false ──
  if (geocode && !dryRun && !formsOnly) {
    const ids = records.map((r) => r.id)
    const { data: ungeo, error: gErr } = await verco
      .from('eligible_properties')
      .select('id')
      .eq('external_source', EXTERNAL_SOURCE)
      .in('external_id', ids)
      .eq('has_geocode', false)
    if (gErr) throw new Error(`geocode lookup: ${gErr.message}`)
    const propertyIds = (ungeo ?? []).map((r) => (r as { id: string }).id)
    if (propertyIds.length > 0) {
      console.log(`\nGeocoding ${propertyIds.length} properties via geocode-properties EF…`)
      const res = await fetch(`${supabaseUrl}/functions/v1/geocode-properties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ property_ids: propertyIds }),
      })
      console.log(`  EF HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`)
      if (!res.ok) process.exitCode = 1
    }
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
