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
 * font-size class group; this pins that config. If a new --text-* token is
 * added to globals.css, add it to BOTH lib/utils.ts and this list.
 */
const CUSTOM_SIZES = [
  'text-2xs',
  'text-caption',
  'text-body-sm',
  'text-body',
  'text-subtitle',
  'text-title',
  'text-display',
]

describe('cn preserves custom @theme font sizes alongside text colours', () => {
  it.each(CUSTOM_SIZES)('%s survives a following text colour', (size) => {
    const merged = cn(size, 'text-gray-900')
    expect(merged).toContain(size)
    expect(merged).toContain('text-gray-900')
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
