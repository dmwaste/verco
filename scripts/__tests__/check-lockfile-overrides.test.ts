import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { diffOverrides, parseLockfileOverrides } from '../check-lockfile-overrides'

const LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  '@babel/core': ^7.29.6
  brace-expansion@>=2.0.0 <2.1.2: ^2.1.2
  qs@<6.16.0: ^6.16.0
  vite: ^7.3.5

importers:

  .:
    dependencies:
      vite:
        specifier: ^7.3.5
`

describe('parseLockfileOverrides', () => {
  it('reads quoted and unquoted keys, including range keys with spaces', () => {
    expect(parseLockfileOverrides(LOCKFILE)).toEqual({
      '@babel/core': '^7.29.6',
      'brace-expansion@>=2.0.0 <2.1.2': '^2.1.2',
      'qs@<6.16.0': '^6.16.0',
      vite: '^7.3.5',
    })
  })

  it('returns an empty map when the block was stripped (the #602 failure)', () => {
    const stripped = LOCKFILE.replace(/overrides:\n(?: {2}.+\n)+\n/, '')
    expect(parseLockfileOverrides(stripped)).toEqual({})
  })

  it('does not read past the block into importers', () => {
    expect(Object.keys(parseLockfileOverrides(LOCKFILE))).not.toContain('.')
  })
})

describe('diffOverrides', () => {
  const expected = { 'qs@<6.16.0': '^6.16.0', vite: '^7.3.5' }

  it('reports no drift when the maps match', () => {
    expect(diffOverrides(expected, { ...expected })).toEqual({ missing: [], unexpected: [], changed: [] })
  })

  it('names every pin missing from the lockfile', () => {
    expect(diffOverrides(expected, {}).missing).toEqual(['qs@<6.16.0', 'vite'])
  })

  it('flags a pin whose value differs — a rotted pin bumped in only one file', () => {
    expect(diffOverrides(expected, { ...expected, 'qs@<6.16.0': '^6.15.2' }).changed).toEqual([
      { key: 'qs@<6.16.0', expected: '^6.16.0', actual: '^6.15.2' },
    ])
  })

  it('flags a pin left in the lockfile after package.json dropped it', () => {
    expect(diffOverrides(expected, { ...expected, 'tar@<=7.5.20': '^7.5.21' }).unexpected).toEqual([
      'tar@<=7.5.20',
    ])
  })
})

describe("this repo's committed lockfile", () => {
  it('carries every package.json override', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      pnpm: { overrides: Record<string, string> }
    }
    const actual = parseLockfileOverrides(readFileSync('pnpm-lock.yaml', 'utf8'))
    expect(diffOverrides(manifest.pnpm.overrides, actual)).toEqual({ missing: [], unexpected: [], changed: [] })
  })
})
