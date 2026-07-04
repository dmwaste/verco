// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StatusBadge, Pill } from '@/components/status-badge'

describe('StatusBadge dot prop', () => {
  it('renders a leading dot only when the entity style defines one', () => {
    // ticket styles define dot colours
    const { container: ticket } = render(
      <StatusBadge entity="ticket" status="open" dot />
    )
    expect(ticket.querySelectorAll('span').length).toBe(2)

    // booking styles define no dot — dot prop is a silent no-op by design
    const { container: booking } = render(
      <StatusBadge entity="booking" status="Confirmed" dot />
    )
    expect(booking.querySelectorAll('span').length).toBe(1)
  })

  it('renders no dot without the prop even when the style defines one', () => {
    const { container } = render(<StatusBadge entity="ticket" status="open" />)
    expect(container.querySelectorAll('span').length).toBe(1)
  })
})

describe('Pill tones', () => {
  it.each([
    ['success', 'bg-status-success-bg', 'text-status-success'],
    ['warn', 'bg-status-warn-bg', 'text-status-warn'],
    ['error', 'bg-status-error-bg', 'text-status-error'],
    ['info', 'bg-status-info-bg', 'text-status-info'],
    ['neutral', 'bg-gray-100', 'text-gray-600'],
    ['accent', 'bg-[#F3EEFF]', 'text-[#805AD5]'],
  ] as const)('%s applies its token pair', (tone, bg, text) => {
    const { container } = render(<Pill tone={tone}>x</Pill>)
    const span = container.querySelector('span')!
    expect(span.className).toContain(bg)
    expect(span.className).toContain(text)
    // size token survives the colour merge (the ISSUE-001 class of bug)
    expect(span.className).toContain('text-caption')
  })
})
