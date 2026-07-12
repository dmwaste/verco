// scripts/airtable-vv-hygiene.ts
/**
 * VV Airtable hygiene — scans the three Verge Valet bases for data
 * anomalies (orphans, empties, duplicates, unmapped codes) and writes
 * a JSON report. With --apply, deletes orphan Council_Code rows.
 *
 * Pre-flight check: every Airtable Council_Code must map to a Verco
 * collection_area. If any don't, the script exits non-zero so the import
 * cannot proceed against bad data.
 *
 * Usage:
 *   npx tsx scripts/airtable-vv-hygiene.ts                # dry-run, all bases
 *   npx tsx scripts/airtable-vv-hygiene.ts --apply        # delete orphans
 *   npx tsx scripts/airtable-vv-hygiene.ts --base=vic
 *   npx tsx scripts/airtable-vv-hygiene.ts --output=foo.json
 */
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import {
  AIRTABLE_TABLE_IDS,
  deleteAirtableRecord,
  fetchAllEligibleProperties,
  fetchCouncilCodeLookup,
} from './lib/airtable-vv'
import { loadAreaMap, resolveAreaId } from './lib/area-map'
import { normaliseAddress } from './lib/normalise'
import { parseFlags, requireEnv } from './lib/cli'
import { timestamp } from './lib/report'
import { VV_BASES, type VvBase } from './lib/types'

type Finding<T> = T & { baseId: string }
type Report = {
  scannedAt: string
  applied: boolean
  sources: Record<string, { baseId: string; rowsScanned: number }>
  findings: {
    orphan_council_codes: Finding<{ recordId: string; code: string }>[]
    orphan_addresses: Finding<{ recordId: string; address: string }>[]
    unmapped_council_codes: Finding<{ code: string; addressCount: number }>[]
    empty_addresses: Finding<{ recordId: string; address: string }>[]
    within_base_duplicates: Finding<{ council_code: string; normalised: string; records: string[] }>[]
    cross_base_duplicates: { normalised: string; entries: { baseId: string; recordId: string }[] }[]
  }
  summary: Record<string, number>
}

async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const baseFilter = (typeof flags.base === 'string' ? flags.base : undefined) ?? 'all'
  const outputPath = (typeof flags.output === 'string' ? flags.output : undefined)
    ?? `airtable-vv-hygiene-report-${timestamp()}.json`

  const airtableToken = requireEnv('AIRTABLE_TOKEN')
  const supabaseUrl   = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey    = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const verco = createClient(supabaseUrl, serviceKey)

  // Pre-flight: load Verco area map.
  const areaMap = await loadAreaMap(verco)
  console.log(`Loaded ${areaMap.size} Verco collection_areas under vergevalet.`)

  const bases = baseFilter === 'all'
    ? VV_BASES
    : VV_BASES.filter((b) => b.key === baseFilter)
  if (bases.length === 0) {
    console.error(`Unknown base filter: ${baseFilter}. Use main, sub, vic, or all.`)
    process.exit(1)
  }

  const report: Report = {
    scannedAt: new Date().toISOString(),
    applied: apply,
    sources: {},
    findings: {
      orphan_council_codes: [],
      orphan_addresses: [],
      unmapped_council_codes: [],
      empty_addresses: [],
      within_base_duplicates: [],
      cross_base_duplicates: [],
    },
    summary: {},
  }

  const crossBaseSeen = new Map<string, { baseId: string; recordId: string }[]>()

  for (const base of bases) {
    await scanBase(base, airtableToken, areaMap, report, crossBaseSeen)
  }

  // Cross-base dupes — only entries with >1 base
  for (const [normalised, entries] of crossBaseSeen) {
    const baseIds = new Set(entries.map((e) => e.baseId))
    if (baseIds.size > 1) {
      report.findings.cross_base_duplicates.push({ normalised, entries })
    }
  }

  // Summary
  report.summary = {
    orphan_council_codes:    report.findings.orphan_council_codes.length,
    orphan_addresses:        report.findings.orphan_addresses.length,
    unmapped_council_codes:  report.findings.unmapped_council_codes.length,
    empty_addresses:         report.findings.empty_addresses.length,
    within_base_duplicates:  report.findings.within_base_duplicates.length,
    cross_base_duplicates:   report.findings.cross_base_duplicates.length,
  }

  // Apply: delete orphan council codes
  if (apply && report.findings.orphan_council_codes.length > 0) {
    console.log(`\nApplying: deleting ${report.findings.orphan_council_codes.length} orphan Council_Code row(s)...`)
    for (const f of report.findings.orphan_council_codes) {
      await deleteAirtableRecord(f.baseId, AIRTABLE_TABLE_IDS.COUNCIL_CODE, f.recordId, airtableToken)
      console.log(`  ✓ Deleted ${f.recordId} (code="${f.code}") in ${f.baseId}`)
    }
  }

  writeFileSync(outputPath, JSON.stringify(report, null, 2))
  printHumanSummary(report, outputPath, apply)

  // Pre-flight failure -> non-zero exit
  if ((report.summary.unmapped_council_codes ?? 0) > 0) {
    console.error('\n✗ Unmapped Council_Codes found. Fix Airtable or extend area-map.ts before import.')
    process.exit(1)
  }
}

async function scanBase(
  base: VvBase,
  token: string,
  areaMap: Map<string, string>,
  report: Report,
  crossBaseSeen: Map<string, { baseId: string; recordId: string }[]>,
): Promise<void> {
  console.log(`\nScanning base ${base.key} (${base.baseId})...`)

  const codeLookup = await fetchCouncilCodeLookup(base.baseId, token)
  const properties = await fetchAllEligibleProperties(base.baseId, token)
  report.sources[base.key] = { baseId: base.baseId, rowsScanned: properties.length }
  console.log(`  Fetched ${properties.length} eligible properties, ${codeLookup.size} council codes.`)

  // 1. Orphan Council_Code rows (no linked addresses).
  const codesInUse = new Set<string>()
  for (const p of properties) {
    if (p.councilCode) codesInUse.add(p.councilCode)
  }
  for (const [recordId, code] of codeLookup) {
    if (!codesInUse.has(code)) {
      report.findings.orphan_council_codes.push({ baseId: base.baseId, recordId, code })
    }
  }

  // 2. Orphan addresses (no Council_Code link) + 4. empty addresses.
  // 5. Within-base duplicates (same normalised address + same council code).
  const withinSeen = new Map<string, string[]>()
  for (const p of properties) {
    if (!p.councilCode) {
      report.findings.orphan_addresses.push({
        baseId: base.baseId,
        recordId: p.id,
        address: p.address,
      })
    }
    const trimmed = p.address.trim()
    if (trimmed.length < 4) {
      report.findings.empty_addresses.push({
        baseId: base.baseId,
        recordId: p.id,
        address: p.address,
      })
    }
    const key = `${p.councilCode ?? '<none>'}::${normaliseAddress(p.address)}`
    const existing = withinSeen.get(key)
    if (existing) {
      existing.push(p.id)
    } else {
      withinSeen.set(key, [p.id])
    }

    // 6. Cross-base dedup (just record normalised + base + id; collate later)
    const norm = normaliseAddress(p.address)
    if (norm.length > 0) {
      const seen = crossBaseSeen.get(norm)
      if (seen) {
        seen.push({ baseId: base.baseId, recordId: p.id })
      } else {
        crossBaseSeen.set(norm, [{ baseId: base.baseId, recordId: p.id }])
      }
    }
  }
  for (const [key, recordIds] of withinSeen) {
    if (recordIds.length > 1) {
      const sepIdx = key.indexOf('::')
      const council_code = sepIdx >= 0 ? key.slice(0, sepIdx) : key
      const normalised = sepIdx >= 0 ? key.slice(sepIdx + 2) : ''
      report.findings.within_base_duplicates.push({
        baseId: base.baseId,
        council_code,
        normalised,
        records: recordIds,
      })
    }
  }

  // 3. Unmapped Council_Codes — pre-flight against Verco area map.
  const counts = new Map<string, number>()
  for (const p of properties) {
    if (p.councilCode) counts.set(p.councilCode, (counts.get(p.councilCode) ?? 0) + 1)
  }
  for (const [code, count] of counts) {
    const areaId = resolveAreaId(code, areaMap)
    if (!areaId) {
      report.findings.unmapped_council_codes.push({
        baseId: base.baseId,
        code,
        addressCount: count,
      })
    }
  }
}

function printHumanSummary(report: Report, path: string, applied: boolean) {
  const total = Object.values(report.sources).reduce((acc, s) => acc + s.rowsScanned, 0)
  console.log('')
  console.log('Airtable VV Hygiene Report — ' + new Date(report.scannedAt).toLocaleString())
  console.log('═'.repeat(57))
  console.log(`Scanned: ${total.toLocaleString()} rows across ${Object.keys(report.sources).length} base(s).`)
  console.log('')
  for (const [key, count] of Object.entries(report.summary)) {
    const flag = (key === 'orphan_council_codes' && applied) ? ' (deleted)' :
                 (key === 'unmapped_council_codes' && count > 0) ? ' ✗ pre-flight fail' :
                 (key === 'unmapped_council_codes') ? ' ✓ pre-flight ok' : ''
    console.log(`  ${key.padEnd(28)} ${String(count).padStart(5)}${flag}`)
  }
  console.log('')
  console.log(`Report saved to ${path}`)
  if (!applied && (report.summary.orphan_council_codes ?? 0) > 0) {
    console.log(`Re-run with --apply to delete the ${report.summary.orphan_council_codes} orphan Council_Code row(s).`)
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
