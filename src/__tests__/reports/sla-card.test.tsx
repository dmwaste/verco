import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SlaCard, scorecardTone } from '@/app/(admin)/admin/reports/sla-card'

/**
 * Card-render tests for the VER-179 SLA dashboard (spec §6). The metric maths is
 * covered 100% by the pure-fn suites; these lock the RENDER layer — the tone
 * mapping (green/amber/neutral, never red) and the empty / low-n / at-n display
 * contract that each dashboard card feeds <SlaCard>.
 */

describe('scorecardTone', () => {
  it('is neutral when the card is empty (no coloured pass/fail)', () => {
    expect(scorecardTone(null, 98, { isEmpty: true, isLowN: false })).toBe('neutral')
  })

  it('is neutral below the low-n threshold', () => {
    expect(scorecardTone(50, 98, { isEmpty: false, isLowN: true })).toBe('neutral')
  })

  it('is neutral when pct is null even if flagged at-n', () => {
    expect(scorecardTone(null, 98, { isEmpty: false, isLowN: false })).toBe('neutral')
  })

  it('is pass at or above target', () => {
    expect(scorecardTone(98, 98, { isEmpty: false, isLowN: false })).toBe('pass')
    expect(scorecardTone(99.5, 98, { isEmpty: false, isLowN: false })).toBe('pass')
  })

  it('is below (amber) under target — never a red/fail tone', () => {
    expect(scorecardTone(97.9, 98, { isEmpty: false, isLowN: false })).toBe('below')
  })
})

describe('SlaCard', () => {
  it('renders the label and headline value', () => {
    render(<SlaCard label="Clean Collection" value="96.9%" />)
    expect(screen.getByText('Clean Collection')).toBeInTheDocument()
    expect(screen.getByText('96.9%')).toBeInTheDocument()
  })

  it('shows the sub line and target reference when not loading', () => {
    render(<SlaCard label="Clean Collection" value="96.9%" sub="31 / 32 clean" target="Target ≥ 98%" />)
    expect(screen.getByText('31 / 32 clean')).toBeInTheDocument()
    expect(screen.getByText('Target ≥ 98%')).toBeInTheDocument()
  })

  it('renders a dash and hides sub/target while loading', () => {
    render(<SlaCard label="Clean Collection" value="96.9%" sub="hidden sub" target="hidden target" isLoading />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('hidden sub')).not.toBeInTheDocument()
    expect(screen.queryByText('hidden target')).not.toBeInTheDocument()
  })

  it('applies the pass tone (green) at/above target', () => {
    render(<SlaCard label="On-Time" value="99.0%" tone="pass" />)
    expect(screen.getByText('99.0%')).toHaveClass('text-emerald-600')
  })

  it('applies the below tone in amber, never red (pre-go-live rule)', () => {
    render(<SlaCard label="On-Time" value="90.0%" tone="below" />)
    const el = screen.getByText('90.0%')
    expect(el).toHaveClass('text-amber-600')
    expect(el.className).not.toMatch(/red/)
  })

  it('defaults insight/empty/low-n cards to the neutral navy tone', () => {
    render(<SlaCard label="Property Penetration" value="3.1%" />)
    expect(screen.getByText('3.1%')).toHaveClass('text-[#293F52]')
  })

  it('renders the empty-state notice as a plain value with no sub', () => {
    render(<SlaCard label="Resident Satisfaction" value="No responses yet" />)
    expect(screen.getByText('No responses yet')).toBeInTheDocument()
  })
})
