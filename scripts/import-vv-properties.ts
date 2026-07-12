// scripts/import-vv-properties.ts
/**
 * VV Eligible Properties import — pulls from 3 Airtable bases, geocodes
 * SUB+VIC via Google, upserts to Verco eligible_properties.
 *
 * Idempotent: re-runs skip rows already imported (matched on
 * external_source + external_id). Failed geocodes are logged to a
 * report file and the row is inserted with has_geocode=false.
 *
 * Usage:
 *   npx tsx scripts/import-vv-properties.ts                  # full import
 *   npx tsx scripts/import-vv-properties.ts --dry-run        # no I/O writes
 *   npx tsx scripts/import-vv-properties.ts --source=vic
 *   npx tsx scripts/import-vv-properties.ts --limit=50       # smoke test
 *   npx tsx scripts/import-vv-properties.ts --skip-geocode
 */
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { fetchAllEligibleProperties } from './lib/airtable-vv'
import { loadAreaMap, resolveAreaId } from './lib/area-map'
import { geocodeAddress } from './lib/geocode'
import { toVercoRow } from './lib/transform'
import { dedupeByPlaceId } from './lib/dedupe-properties'
import {
  fetchExistingExternalIds,
  fetchExistingPlaceIds,
  upsertEligibleProperties,
} from './lib/verco-upsert'
import { parseFlags, requireEnv } from './lib/cli'
import { timestamp } from './lib/report'
import { VV_BASES, type EligiblePropertyInsert } from './lib/types'

const GEOCODE_QPS = 50      // Google default
const GEOCODE_INTERVAL_MS = Math.ceil(1000 / GEOCODE_QPS)

async function main() {
  const flags = parseFlags(process.argv)
  const dryRun = !!flags['dry-run']
  const skipGeocode = !!flags['skip-geocode']
  const sourceFilter = (typeof flags.source === 'string' ? flags.source : undefined) ?? 'all'
  const limit = typeof flags.limit === 'string' ? Number(flags.limit) : null

  const airtableToken = requireEnv('AIRTABLE_TOKEN')
  const supabaseUrl   = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey    = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const googleKey     = skipGeocode || dryRun ? '' : requireEnv('GOOGLE_GEOCODING_API_KEY')

  const verco = createClient(supabaseUrl, serviceKey)
  const areaMap = await loadAreaMap(verco)
  console.log(`Loaded ${areaMap.size} Verco collection_areas under vergevalet.`)

  // Physical-property dedup: place_ids already in Verco for this client. The
  // pre-filter below skips rows by Airtable record id, but the VV base holds
  // DIFFERENT records for the same house (one correct, one mis-coded to the
  // wrong council). Without this guard those re-import as duplicates and the
  // booking lookup reports the address "not eligible". Mutated per base so a
  // later base sees survivors from an earlier one. See dedupe-properties.ts.
  const existingPlaceIds = dryRun
    ? new Set<string>()
    : await fetchExistingPlaceIds(verco, [...areaMap.values()])
  console.log(`Loaded ${existingPlaceIds.size} existing place_ids for dedup.`)
  const dupeDropped: { existing: number; inBatch: number } = { existing: 0, inBatch: 0 }

  const bases = sourceFilter === 'all'
    ? VV_BASES
    : VV_BASES.filter((b) => b.key === sourceFilter)
  if (bases.length === 0) {
    console.error(`Unknown source: ${sourceFilter}. Use main, sub, vic, or all.`)
    process.exit(1)
  }

  const failedGeocodes: { baseId: string; recordId: string; address: string }[] = []
  const unmappedCodes: { baseId: string; recordId: string; code: string }[] = []
  const orphanAddresses: { baseId: string; recordId: string; address: string }[] = []
  const emptyAddresses: { baseId: string; recordId: string; address: string }[] = []
  const counts: Record<string, { newRows: number; skipped: number; upserted: number; failedBatches: number }> = {}

  for (const base of bases) {
    console.log(`\n─── Base ${base.key} (${base.baseId}) ───`)
    const externalSource = `airtable:${base.baseId}`

    // 1. Fetch from Airtable.
    let airtableRows = await fetchAllEligibleProperties(base.baseId, airtableToken)
    if (limit) airtableRows = airtableRows.slice(0, limit)
    console.log(`  Fetched ${airtableRows.length} rows from Airtable.`)

    // 2. Pre-filter: existing external_ids in Verco for this source.
    const existing = await fetchExistingExternalIds(verco, externalSource)
    const newRows = airtableRows.filter((r) => !existing.has(r.id))
    console.log(`  Existing in Verco: ${existing.size}; New to import: ${newRows.length}`)

    // 3. Geocode (only NEW SUB/VIC rows; skipped in dry-run or --skip-geocode).
    // 4. Transform + collect insertable rows.
    const insertable: EligiblePropertyInsert[] = []
    for (const row of newRows) {
      const code = row.councilCode
      if (!code) {
        // Row has no Council_Code link in Airtable. Operationally this means
        // the row was never associated with a council — likely a data-entry
        // miss. Hygiene script reports these as orphan_addresses[]. We log
        // and skip rather than abort (cf. unmapped codes, which are a real
        // config issue and DO abort below).
        orphanAddresses.push({ baseId: base.baseId, recordId: row.id, address: row.address })
        continue
      }
      const areaId = resolveAreaId(code, areaMap)
      if (!areaId) {
        unmappedCodes.push({ baseId: base.baseId, recordId: row.id, code })
        continue
      }
      // Defensive: empty/short addresses pass NOT NULL but break public lookup.
      // Hygiene script flags these as `empty_addresses`; this is the final gate.
      if (row.address.trim().length < 4) {
        emptyAddresses.push({ baseId: base.baseId, recordId: row.id, address: row.address })
        continue
      }

      let geocode = null
      if (!base.hasGeocode && !skipGeocode && !dryRun) {
        const startedAt = Date.now()
        try {
          geocode = await geocodeAddress(row.address, googleKey)
        } catch (err) {
          console.error(`  Geocode error for ${row.id}: ${(err as Error).message}`)
        }
        if (!geocode) {
          failedGeocodes.push({ baseId: base.baseId, recordId: row.id, address: row.address })
        }
        const elapsed = Date.now() - startedAt
        if (elapsed < GEOCODE_INTERVAL_MS) await sleep(GEOCODE_INTERVAL_MS - elapsed)
      }

      insertable.push(toVercoRow(row, base.baseId, areaId, geocode))
    }

    // 5. Dedup by physical property (place_id), then upsert.
    const deduped = dedupeByPlaceId(insertable, existingPlaceIds)
    dupeDropped.existing += deduped.droppedExisting.length
    dupeDropped.inBatch += deduped.droppedInBatch.length
    if (deduped.droppedExisting.length || deduped.droppedInBatch.length) {
      console.log(
        `  Dedup: dropped ${deduped.droppedExisting.length} already-in-Verco + ` +
        `${deduped.droppedInBatch.length} same-place_id-in-batch; ` +
        `${deduped.kept.length} to upsert.`
      )
    }

    let upsertResult = { ok: 0, failedBatches: 0 }
    if (!dryRun && deduped.kept.length > 0) {
      upsertResult = await upsertEligibleProperties(verco, deduped.kept, (done, total) => {
        process.stdout.write(`\r  Upserting... ${done}/${total}`)
      })
      process.stdout.write('\n')
    } else if (dryRun) {
      console.log(`  DRY RUN — would upsert ${deduped.kept.length} rows.`)
    }

    counts[base.key] = {
      newRows: newRows.length,
      skipped: airtableRows.length - newRows.length,
      upserted: upsertResult.ok,
      failedBatches: upsertResult.failedBatches,
    }
  }

  // 6. Save report FIRST — so a hard-exit on unmapped codes still leaves a diagnostic on disk.
  const report = {
    completedAt: new Date().toISOString(),
    dryRun,
    counts,
    dupeDropped,
    failedGeocodes,
    unmappedCodes,
    orphanAddresses,
    emptyAddresses,
  }
  const path = `import-vv-report-${timestamp()}.json`
  writeFileSync(path, JSON.stringify(report, null, 2))

  console.log('\n═════════════════════════════════════════════════════════')
  console.log(`Done. ${dryRun ? '(DRY RUN — no writes)' : ''}`)
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(5)}  new=${v.newRows}  skipped=${v.skipped}  upserted=${v.upserted}  failedBatches=${v.failedBatches}`)
  }
  console.log(`Dedup dropped: ${dupeDropped.existing} already-in-Verco + ${dupeDropped.inBatch} same-place_id-in-batch`)
  console.log(`Failed geocodes: ${failedGeocodes.length}`)
  console.log(`Orphan addresses skipped (no Council_Code link): ${orphanAddresses.length}`)
  console.log(`Empty addresses skipped (< 4 chars): ${emptyAddresses.length}`)
  console.log(`Report: ${path}`)

  // 7. Hard abort on unmapped codes (defensive — hygiene should catch first).
  //    Done AFTER writing the report so ops always gets a diagnostic.
  if (unmappedCodes.length > 0) {
    console.error(`\n✗ ${unmappedCodes.length} row(s) had unmapped Council_Codes. Sample:`)
    for (const u of unmappedCodes.slice(0, 5)) {
      console.error(`    ${u.baseId} ${u.recordId} code="${u.code}"`)
    }
    process.exit(1)
  }

  // 8. Verification queries — only on a successful (zero-unmapped) run, where
  //    they're a useful next step. On a failed run they'd be misleading guidance.
  console.log('')
  console.log('Run these verification queries against Verco:')
  console.log("  SELECT ca.code, count(*) FROM eligible_properties ep")
  console.log("    JOIN collection_area ca ON ca.id = ep.collection_area_id")
  console.log("    JOIN client c ON c.id = ca.client_id")
  console.log("    WHERE c.slug = 'vergevalet' GROUP BY ca.code ORDER BY ca.code;")
  console.log('')
  console.log("  SELECT external_source, count(*) total,")
  console.log("    count(*) FILTER (WHERE has_geocode) geocoded,")
  console.log("    round(100.0 * count(*) FILTER (WHERE has_geocode) / count(*), 1) pct")
  console.log("  FROM eligible_properties WHERE external_source LIKE 'airtable:%'")
  console.log("  GROUP BY external_source;")
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
