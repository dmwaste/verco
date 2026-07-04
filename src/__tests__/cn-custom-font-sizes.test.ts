import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { cn } from '@/lib/utils'

/**
 * Regression: ISSUE-001 — custom @theme font sizes silently dropped by cn().
 * Found by /qa on 2026-07-04 (report: .gstack/qa-reports/qa-report-localhost-2026-07-04.md).
 *
 * Stock tailwind-merge classifies unknown `text-<value>` utilities as text
 * COLOURS, so a custom font size + a real colour in one cn() call "conflict"
 * and the size (earlier in the string) is dropped: FieldLabel rendered 16px
 * instead of 11px, Input 16px instead of 13px, and the shipped Th/StatusBadge/
 * Pill had the same drop. lib/utils.ts registers the @theme sizes in the
 * font-size class group; this pins that config.
 *
 * The token list is DERIVED from globals.css, so adding a new --text-* token
 * there without registering it in lib/utils.ts fails here instead of silently
 * dropping in the UI.
 */
const globalsCss = readFileSync(join(__dirname, '../app/globals.css'), 'utf8')
const CUSTOM_SIZES = [...globalsCss.matchAll(/--text-([a-z0-9-]+):/g)].map(
  (m) => `text-${m[1]}`
)

describe('cn preserves custom @theme font sizes alongside text colours', () => {
  it('derives the token list from globals.css (sanity: all 7 present)', () => {
    expect(CUSTOM_SIZES).toEqual(
      expect.arrayContaining([
        'text-2xs',
        'text-caption',
        'text-body-sm',
        'text-body',
        'text-subtitle',
        'text-title',
        'text-display',
      ])
    )
  })

  it.each(CUSTOM_SIZES)('%s survives a following text colour', (size) => {
    const merged = cn(size, 'text-gray-900')
    expect(merged).toContain(size)
    expect(merged).toContain('text-gray-900')
  })

  it('custom and stock font sizes share one group (later wins both ways)', () => {
    expect(cn('text-body-sm', 'text-sm')).toBe('text-sm')
    expect(cn('text-sm', 'text-body-sm')).toBe('text-body-sm')
  })

  it('caller className overrides FIELD_BASE padding/radius/background axes', () => {
    const base =
      'w-full rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2.5 text-body-sm text-gray-900'
    expect(cn(base, 'py-2')).not.toContain('py-2.5')
    expect(cn(base, 'rounded-[10px]')).not.toContain('rounded-lg')
    expect(cn(base, 'bg-gray-100')).not.toContain('bg-gray-50')
  })

  it('the real FieldLabel combination keeps size + colour', () => {
    const merged = cn('mb-1.5 block text-caption font-semibold uppercase tracking-wide text-gray-500')
    expect(merged).toContain('text-caption')
    expect(merged).toContain('text-gray-500')
  })

  it('the real StatusBadge combination keeps size + status colour', () => {
    const merged = cn(
      'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-caption font-semibold',
      'bg-status-warn-bg',
      'text-status-warn'
    )
    expect(merged).toContain('text-caption')
    expect(merged).toContain('text-status-warn')
  })

  it('two custom sizes still conflict (later wins) — they are one group', () => {
    expect(cn('text-body-sm', 'text-caption')).toBe('text-caption')
  })

  it('caller size override still beats the base size', () => {
    const merged = cn('text-body-sm text-gray-900', 'text-2xs')
    expect(merged).toContain('text-2xs')
    expect(merged).not.toContain('text-body-sm')
    expect(merged).toContain('text-gray-900')
  })
})
