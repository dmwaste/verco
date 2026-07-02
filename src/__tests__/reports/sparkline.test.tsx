import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Sparkline } from '@/app/(admin)/admin/reports/sparkline'

/**
 * Render-layer tests for the VER-297 rolling-12 sparkline: empty-series null
 * render, the all-zeros max guard (flat baseline, no NaN geometry), and the
 * aria data summary (SVG children are presentational, so the label must
 * carry the numbers — deterministic MONTH_ABBR labels, never Intl).
 */

describe('Sparkline', () => {
  it('renders nothing for an empty series', () => {
    const { container } = render(<Sparkline points={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('an all-zero series draws a flat baseline with no NaN geometry', () => {
    const { container } = render(
      <Sparkline
        points={[
          { month: '2026-05-01', value: 0 },
          { month: '2026-06-01', value: 0 },
        ]}
        caption="c"
      />,
    )
    const line = container.querySelector('polyline')!
    expect(line.getAttribute('points')).toBe('0.00,26.00 100.00,26.00')
    expect(line.getAttribute('points')).not.toMatch(/NaN/)
  })

  it('scales values against the series max', () => {
    const { container } = render(
      <Sparkline
        points={[
          { month: '2026-05-01', value: 0 },
          { month: '2026-06-01', value: 10 }, // max → y = TOP (2)
        ]}
      />,
    )
    expect(container.querySelector('polyline')!.getAttribute('points')).toBe(
      '0.00,26.00 100.00,2.00',
    )
  })

  it('carries latest + peak values in the aria summary and tooltip', () => {
    render(
      <Sparkline
        points={[
          { month: '2026-05-01', value: 9 },
          { month: '2026-06-01', value: 4 },
        ]}
        caption="Completed stops"
      />,
    )
    expect(
      screen.getByRole('img', {
        name: 'Completed stops — latest Jun 2026: 4; peak May 2026: 9',
      }),
    ).toBeInTheDocument()
  })

  it('renders the caption below the line', () => {
    render(<Sparkline points={[{ month: '2026-06-01', value: 1 }]} caption="last 12 months" />)
    expect(screen.getByText('last 12 months')).toBeInTheDocument()
  })
})
