import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TrendBars } from '@/app/(admin)/admin/reports/trend-bars'

/**
 * Render-layer tests for the VER-297 rolling-12 strip: empty-series null
 * render, the all-zeros max guard (no NaN heights), human month tooltips,
 * and the aria data summary (children of role="img" are presentational, so
 * the label must carry the numbers).
 */

describe('TrendBars', () => {
  it('renders nothing for an empty series', () => {
    const { container } = render(<TrendBars points={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('an all-zero series does not produce NaN heights (max guard)', () => {
    render(<TrendBars points={[{ month: '2026-06-01', value: 0 }]} caption="c" />)
    const bar = screen.getByTitle('Jun 2026: 0')
    expect(bar.style.height).toBe('4%')
  })

  it('formats tooltips as human month labels', () => {
    render(<TrendBars points={[{ month: '2026-03-01', value: 42 }]} />)
    expect(screen.getByTitle('Mar 2026: 42')).toBeInTheDocument()
  })

  it('carries latest + peak values in the aria summary', () => {
    render(
      <TrendBars
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
})
