import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StuckCloseoutsCallout } from '@/app/(admin)/admin/stuck-closeouts-callout'

/**
 * #575 dashboard entry point: the office reaches the stale-closeout worklist
 * without waiting for the 09:35 Teams alert. The link must open the same list
 * the alert's "Full backlog" link opens, so the count and the list agree.
 */
describe('StuckCloseoutsCallout', () => {
  it('links to Scheduled bookings on or before the stale cutoff, with the count', () => {
    render(<StuckCloseoutsCallout count={12} cutoffDate="2026-10-17" />)
    const link = screen.getByRole('link', { name: /Stuck closeouts \(12\)/ })
    expect(link.getAttribute('href')).toBe('/admin/bookings?status=Scheduled&date_to=2026-10-17')
    expect(link.textContent).toContain('12 bookings 3+ days past collection, not closed out')
  })

  it('uses the singular for one booking', () => {
    render(<StuckCloseoutsCallout count={1} cutoffDate="2026-10-17" />)
    expect(screen.getByRole('link').textContent).toContain('1 booking 3+ days past collection')
  })

  it('renders nothing when no booking is stuck', () => {
    const { container } = render(<StuckCloseoutsCallout count={0} cutoffDate="2026-10-17" />)
    expect(container.innerHTML).toBe('')
  })
})
