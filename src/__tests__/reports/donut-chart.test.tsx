import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DonutChart } from '@/app/(admin)/admin/reports/donut-chart'

/**
 * Render-layer tests for the reports donut (review 02/07): zero-total null
 * render (caller owns the empty state), zero-value segment filtering, arc
 * offset accumulation, legend shares, and the aria data summary.
 */

describe('DonutChart', () => {
  it('renders nothing when every segment is zero (caller owns the empty state)', () => {
    const { container } = render(
      <DonutChart ariaLabel="x" segments={[{ label: 'A', value: 0, color: '#000' }]} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('drops zero-value segments from arcs, legend and the aria summary', () => {
    render(
      <DonutChart
        ariaLabel="Mix"
        segments={[
          { label: 'A', value: 3, color: '#000' },
          { label: 'B', value: 0, color: '#111' },
        ]}
      />,
    )
    expect(screen.getByRole('img', { name: 'Mix — A: 3' })).toBeInTheDocument()
    expect(screen.queryByText('B')).toBeNull()
  })

  it('accumulates arc offsets so segments tile the ring without overlap', () => {
    const { container } = render(
      <DonutChart
        ariaLabel="Mix"
        segments={[
          { label: 'A', value: 1, color: '#000' },
          { label: 'B', value: 3, color: '#111' },
        ]}
      />,
    )
    // Segment circles follow the track circle.
    const [, a, b] = [...container.querySelectorAll('circle')]
    const lenA = Number(a!.getAttribute('stroke-dasharray')!.split(' ')[0])
    const offsetB = Math.abs(Number(b!.getAttribute('stroke-dashoffset')))
    expect(offsetB).toBeCloseTo(lenA, 5) // B starts exactly where A ends
  })

  it('legend carries counts and whole-percent shares', () => {
    render(
      <DonutChart
        ariaLabel="Mix"
        segments={[
          { label: 'A', value: 1, color: '#000' },
          { label: 'B', value: 3, color: '#111' },
        ]}
      />,
    )
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('renders duplicate labels without key collisions (genuine "Other" reason)', () => {
    render(
      <DonutChart
        ariaLabel="Mix"
        segments={[
          { label: 'Other', value: 2, color: '#000' },
          { label: 'Other', value: 1, color: '#111' },
        ]}
      />,
    )
    expect(screen.getAllByText('Other')).toHaveLength(2)
  })
})
