import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BookingTypeBadge } from '@/components/field/booking-type-badge'

/**
 * Job-type marker for crews: a MUD or Illegal Dumping stop must be
 * unmistakable on the run sheet — residential is the unmarked default.
 */
describe('BookingTypeBadge', () => {
  it('labels a MUD booking with its unit count', () => {
    render(<BookingTypeBadge type="MUD" unitCount={38} />)
    expect(screen.getByText('MUD · 38 units')).toBeInTheDocument()
  })

  it('shows a bare MUD when the unit count is unknown (0 / 1 / null)', () => {
    const { unmount } = render(<BookingTypeBadge type="MUD" unitCount={0} />)
    expect(screen.getByText('MUD')).toBeInTheDocument()
    unmount()
    render(<BookingTypeBadge type="MUD" unitCount={1} />)
    expect(screen.getByText('MUD')).toBeInTheDocument()
  })

  it('labels an Illegal Dumping booking as ID', () => {
    render(<BookingTypeBadge type="Illegal Dumping" unitCount={null} />)
    expect(screen.getByText('ID')).toBeInTheDocument()
  })

  it('renders nothing for a residential booking', () => {
    const { container } = render(<BookingTypeBadge type="Residential" unitCount={1} />)
    expect(container).toBeEmptyDOMElement()
  })
})
