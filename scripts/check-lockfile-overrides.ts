// Fails when pnpm-lock.yaml's `overrides:` block no longer matches
// package.json's `pnpm.overrides` (#602).
//
// Those overrides are transitive SECURITY pins. pnpm 11+ stopped reading
// `package.json#pnpm`, so any tool running a newer pnpm (Dependabot did, until
// `packageManager` pinned it) rewrites the lockfile with every pin silently
// dropped. `pnpm install --frozen-lockfile` then refuses with an opaque
// ERR_PNPM_LOCKFILE_CONFIG_MISMATCH across five unrelated CI jobs; this check
// names the dropped pins instead.
//
// Self-contained (no deps, no relative imports) so CI can run it with plain
// `node` BEFORE `pnpm install` — the install is exactly what fails on drift.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export type OverrideDrift = {
  missing: string[]
  unexpected: string[]
  changed: { key: string; expected: string; actual: string }[]
}

function unquote(raw: string): string {
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'")
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  return raw
}

// Reads the top-level `overrides:` map of a pnpm v9 lockfile. pnpm writes it
// as flat `  key: value` lines (keys quoted only when YAML needs it), ended by
// a blank line — no general YAML parser needed.
export function parseLockfileOverrides(lockfile: string): Record<string, string> {
  const lines = lockfile.split('\n')
  const start = lines.indexOf('overrides:')
  if (start === -1) return {}
  const overrides: Record<string, string> = {}
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break
    const match = /^ {2}('(?:[^']|'')*'|"[^"]*"|[^:]+): (.+)$/.exec(line)
    if (!match?.[1] || !match[2]) continue
    overrides[unquote(match[1])] = unquote(match[2])
  }
  return overrides
}

export function diffOverrides(
  expected: Record<string, string>,
  actual: Record<string, string>,
): OverrideDrift {
  const drift: OverrideDrift = { missing: [], unexpected: [], changed: [] }
  for (const [key, value] of Object.entries(expected)) {
    const got = actual[key]
    if (got === undefined) drift.missing.push(key)
    else if (got !== value) drift.changed.push({ key, expected: value, actual: got })
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) drift.unexpected.push(key)
  }
  return drift
}

function main(): void {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    pnpm?: { overrides?: Record<string, string> }
  }
  const expected = manifest.pnpm?.overrides ?? {}
  const actual = parseLockfileOverrides(readFileSync('pnpm-lock.yaml', 'utf8'))
  const { missing, unexpected, changed } = diffOverrides(expected, actual)

  if (missing.length + unexpected.length + changed.length === 0) {
    console.log(`All ${Object.keys(expected).length} pnpm overrides are present in pnpm-lock.yaml.`)
    return
  }

  console.error('pnpm-lock.yaml does not match package.json pnpm.overrides (security pins, #602).')
  if (missing.length) console.error(`\nMissing from the lockfile:\n  ${missing.join('\n  ')}`)
  if (changed.length) {
    console.error(
      `\nDifferent value in the lockfile:\n  ${changed
        .map((c) => `${c.key}: package.json ${c.expected}, lockfile ${c.actual}`)
        .join('\n  ')}`,
    )
  }
  if (unexpected.length) console.error(`\nIn the lockfile but not package.json:\n  ${unexpected.join('\n  ')}`)
  console.error(
    '\nThe lockfile was most likely written by pnpm 11+, which ignores package.json#pnpm.' +
      '\nRegenerate it with the pinned pnpm (package.json "packageManager"): pnpm install --no-frozen-lockfile',
  )
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
