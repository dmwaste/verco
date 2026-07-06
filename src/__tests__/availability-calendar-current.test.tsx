// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, within } from '@testing-library/react'
import { AvailabilityCalendar } from '@/components/booking/availability-calendar'

const HELD = { id: 'held', date: new Date(2026, 8, 15), status: 'current' as const }
const OPEN = { id: 'open', date: new Date(2026, 8, 16), status: 'available' as const }

describe('AvailabilityCalendar — current (held) date', () => {
  it('announces the held cell as the current booking date, not "available"', () => {
    const { container } = render(
      <AvailabilityCalendar dates={[HELD]} selectedId="held" onSelect={() => {}} />,
    )
    // aria-label must not fall through to "available" for a current cell
    expect(within(container).getByLabelText(/current booking date/i)).toBeTruthy()
  })

  it('shows the "Current date" legend when a current cell is present', () => {
    const { container } = render(
      <AvailabilityCalendar dates={[HELD]} selectedId="held" onSelect={() => {}} />,
    )
    expect(within(container).getByText('Current date')).toBeTruthy()
  })

  it('hides the "Current date" legend for a normal (new-booking) calendar', () => {
    const { container } = render(
      <AvailabilityCalendar dates={[OPEN]} selectedId={null} onSelect={() => {}} />,
    )
    expect(within(container).queryByText('Current date')).toBeNull()
  })
})
