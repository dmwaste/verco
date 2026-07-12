// scripts/run-geocode-loop.ts
/**
 * Chunked-loop runner for the `geocode-properties` Edge Function.
 *
 * The EF processes up to N eligible_properties rows per invocation
 * (filter: google_place_id IS NULL) and writes back canonical Google
 * place_id + formatted_address. It's idempotent — if this script crashes
 * partway, just re-run it and it picks up the remaining rows.
 *
 * Cost: ~$5 per 1,000 Google Geocoding API calls. The script prints an
 * estimate before kicking off and refuses to run without --yes when the
 * estimated spend exceeds $10.
 *
 * Usage:
 *   npx tsx scripts/run-geocode-loop.ts --yes                              # full run
 *   npx tsx scripts/run-geocode-loop.ts --dry-run --max-chunks=1           # smoke (no DB writes, still costs Google calls)
 *   npx tsx scripts/run-geocode-loop.ts --yes --max-chunks=5               # bounded
 *   npx tsx scripts/run-geocode-loop.ts --yes --external-source=airtable:appWSysd50QoVaaRD
 *   npx tsx scripts/run-geocode-loop.ts --yes --limit-per-chunk=250 --delay-ms=3000
 *
 * Required env:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { parseFlags, requireEnv } from './lib/cli'
import { timestamp } from './lib/report'
import {
  parseEfResponse,
  estimateCostUsd,
  formatEta,
  decideNext,
  type GeocodeEfResponse,
} from './lib/geocode-loop'

const DEFAULT_LIMIT_PER_CHUNK = 500
const DEFAULT_DELAY_MS = 2_000
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3
// Google's $200/month Maps Platform credit covers ~40K Geocoding calls.
// PR #19 estimated ~10K free remaining after autocomplete usage. Caller
// overrides via --free-quota=N if their billing month differs.
const DEFAULT_FREE_QUOTA = 10_000
// Spend threshold above which the script demands explicit --yes
const CONFIRM_THRESHOLD_USD = 10

async function main() {
  const flags = parseFlags(process.argv)
  const dryRun = !!flags['dry-run']
  const yes = !!flags.yes
  const skipPreflight = !!flags['no-preflight']
  const limitPerChunk =
    typeof flags['limit-per-chunk'] === 'string'
      ? Math.max(1, Math.min(Number(flags['limit-per-chunk']), 50_000))
      : DEFAULT_LIMIT_PER_CHUNK
  const maxChunks =
    typeof flags['max-chunks'] === 'string' ? Math.max(1, Number(flags['max-chunks'])) : null
  const delayMs =
    typeof flags['delay-ms'] === 'string' ? Math.max(0, Number(flags['delay-ms'])) : DEFAULT_DELAY_MS
  const maxConsecutiveFailures =
    typeof flags['max-consecutive-failures'] === 'string'
      ? Math.max(1, Number(flags['max-consecutive-failures']))
      : DEFAULT_MAX_CONSECUTIVE_FAILURES
  const externalSource =
    typeof flags['external-source'] === 'string' ? flags['external-source'] : null
  const freeQuotaRemaining =
    typeof flags['free-quota'] === 'string'
      ? Math.max(0, Number(flags['free-quota']))
      : DEFAULT_FREE_QUOTA

  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

  console.log('═══ geocode-properties loop runner ═══')
  console.log(`  limit_per_chunk:          ${limitPerChunk}`)
  console.log(`  max_chunks:               ${maxChunks ?? '(unbounded)'}`)
  console.log(`  delay_ms_between_chunks:  ${delayMs}`)
  console.log(`  max_consecutive_failures: ${maxConsecutiveFailures}`)
  console.log(`  external_source filter:   ${externalSource ?? '(all)'}`)
  console.log(`  dry_run:                  ${dryRun}`)
  console.log('')

  // 1. Pre-flight: count remaining rows + cost estimate.
  let remainingRows: number | null = null
  if (!skipPreflight) {
    const verco = createClient(supabaseUrl, serviceKey)
    let q = verco
      .from('eligible_properties')
      .select('id', { count: 'exact', head: true })
      .is('google_place_id', null)
    if (externalSource) q = q.eq('external_source', externalSource)
    const { count, error } = await q
    if (error) {
      console.error(`✗ Pre-flight count failed: ${error.message}`)
      process.exit(1)
    }
    remainingRows = count ?? 0
    const estCost = estimateCostUsd(remainingRows, freeQuotaRemaining)
    const estChunks = Math.ceil(remainingRows / limitPerChunk)
    console.log(`Pre-flight:`)
    console.log(`  Rows with google_place_id IS NULL:  ${remainingRows.toLocaleString()}`)
    console.log(`  Free-tier remaining (assumed):      ${freeQuotaRemaining.toLocaleString()}`)
    console.log(`  Estimated billable rows:            ${Math.max(0, remainingRows - freeQuotaRemaining).toLocaleString()}`)
    console.log(`  Estimated Google API spend:         USD $${estCost.toFixed(2)}`)
    console.log(`  Estimated chunks at ${limitPerChunk}/chunk:        ${estChunks}`)
    console.log('')

    if (remainingRows === 0) {
      console.log('✓ Nothing to do — every property already has google_place_id.')
      process.exit(0)
    }

    if (estCost > CONFIRM_THRESHOLD_USD && !yes && !dryRun) {
      console.error(
        `✗ Estimated spend USD $${estCost.toFixed(
          2,
        )} exceeds the USD $${CONFIRM_THRESHOLD_USD} confirmation threshold.`,
      )
      console.error('  Re-run with --yes to proceed, or constrain scope with --max-chunks=N.')
      process.exit(1)
    }
  } else if (!yes && !dryRun) {
    console.error('✗ --no-preflight requires --yes (you opted out of the cost estimate).')
    process.exit(1)
  }

  // 2. Loop.
  const endpoint = `${supabaseUrl}/functions/v1/geocode-properties`
  const startedAt = Date.now()
  let chunkNum = 0
  let cumulativeProcessed = 0
  let cumulativeFailed = 0
  let consecutiveFailures = 0
  let abortReason: string | null = null
  const chunkLog: Array<{
    chunk: number
    elapsedMs: number
    response: GeocodeEfResponse | null
    error: string | null
  }> = []

  while (true) {
    if (maxChunks !== null && chunkNum >= maxChunks) {
      console.log(`\n→ Reached --max-chunks=${maxChunks}, stopping.`)
      break
    }
    chunkNum++

    const chunkStartedAt = Date.now()
    const body: Record<string, unknown> = { limit: limitPerChunk }
    if (dryRun) body.dry_run = true
    if (externalSource) body.external_source = externalSource

    let rawResponse: unknown = null
    let networkError: string | null = null
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      try {
        rawResponse = JSON.parse(text)
      } catch {
        networkError = `Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`
      }
      if (!res.ok && !networkError) {
        // EF returned a JSON error envelope with non-2xx; let parseEfResponse handle it
      }
    } catch (err) {
      networkError = err instanceof Error ? err.message : String(err)
    }

    const elapsedMs = Date.now() - chunkStartedAt
    const parsed = networkError
      ? { ok: false as const, error: networkError }
      : parseEfResponse(rawResponse)
    const decision = decideNext(parsed, consecutiveFailures, maxConsecutiveFailures)

    if (parsed.ok) {
      consecutiveFailures = 0
      cumulativeProcessed += parsed.data.processed
      cumulativeFailed += parsed.data.failed

      const ratePerSec =
        elapsedMs > 0 ? (parsed.data.processed + parsed.data.failed) / (elapsedMs / 1000) : 0
      const cumulativeRows = cumulativeProcessed + cumulativeFailed
      const projectedRemaining =
        remainingRows !== null ? Math.max(0, remainingRows - cumulativeRows) : null
      const eta =
        projectedRemaining !== null ? formatEta(projectedRemaining, ratePerSec) : '—'

      console.log(
        `[chunk ${chunkNum}${maxChunks ? `/${maxChunks}` : ''}] ` +
          `total=${parsed.data.total} processed=${parsed.data.processed} ` +
          `failed=${parsed.data.failed}  elapsed=${(elapsedMs / 1000).toFixed(1)}s  ` +
          `cum=${cumulativeRows.toLocaleString()} rate=${ratePerSec.toFixed(1)}/s  ` +
          `ETA=${eta}${parsed.data.dry_run ? '  (dry-run)' : ''}`,
      )

      if (parsed.data.errors && parsed.data.errors.length > 0) {
        const sample = parsed.data.errors.slice(0, 3)
        for (const e of sample) console.log(`   ↳ ${e.id}: ${e.error}`)
      }

      chunkLog.push({
        chunk: chunkNum,
        elapsedMs,
        response: parsed.data,
        error: null,
      })
    } else {
      consecutiveFailures++
      console.error(
        `[chunk ${chunkNum}] ✗ failed (${consecutiveFailures}/${maxConsecutiveFailures}): ${parsed.error}`,
      )
      chunkLog.push({
        chunk: chunkNum,
        elapsedMs,
        response: null,
        error: parsed.error,
      })
    }

    if (decision.kind === 'done') {
      console.log('\n✓ EF reported no remaining rows — loop complete.')
      break
    }
    if (decision.kind === 'abort') {
      abortReason = decision.reason
      console.error(`\n✗ Aborting: ${decision.reason}`)
      break
    }

    if (delayMs > 0) await sleep(delayMs)
  }

  // 3. Final summary + report.
  const totalElapsed = Date.now() - startedAt
  const report = {
    completedAt: new Date().toISOString(),
    dryRun,
    aborted: !!abortReason,
    abortReason,
    config: {
      limitPerChunk,
      maxChunks,
      delayMs,
      maxConsecutiveFailures,
      externalSource,
      freeQuotaRemaining,
    },
    preflightRemainingRows: remainingRows,
    chunksAttempted: chunkNum,
    cumulativeProcessed,
    cumulativeFailed,
    totalElapsedMs: totalElapsed,
    chunkLog,
  }
  const path = `geocode-loop-report-${timestamp()}.json`
  writeFileSync(path, JSON.stringify(report, null, 2))

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log(`Done${dryRun ? ' (DRY RUN — no DB writes)' : ''}${abortReason ? ' — aborted' : ''}.`)
  console.log(`  chunks_attempted:       ${chunkNum}`)
  console.log(`  rows_succeeded:         ${cumulativeProcessed.toLocaleString()}`)
  console.log(`  rows_failed:            ${cumulativeFailed.toLocaleString()}`)
  console.log(`  total_elapsed:          ${(totalElapsed / 1000).toFixed(1)}s`)
  console.log(`  report:                 ${path}`)
  console.log('')
  console.log('Verify with:')
  console.log('  SELECT external_source, count(*) total,')
  console.log("    count(*) FILTER (WHERE google_place_id IS NOT NULL) with_place_id")
  console.log('  FROM eligible_properties GROUP BY external_source ORDER BY external_source;')

  if (abortReason) process.exit(1)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
