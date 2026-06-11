import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RecoveryBanner } from '@/app/landing/recovery-banner'
import { CouncilPicker } from '@/app/landing/council-picker'
import type { PickerClient } from '@/app/landing/picker-state'

const OTHER_COUNCIL: PickerClient = {
  id: 'vv-id',
  slug: 'vergevalet',
  name: 'Verge Valet',
  custom_domain: 'vvtest.verco.au',
  service_name: 'Verge Valet',
  primary_colour: '#414042',
  accent_colour: '#72b75c',
  logo_light_url: null,
  subClients: ['City of Fremantle', 'Town of Cambridge'],
}

/**
 * Composed state (eng review M4): a resident holding a live /b/<ref> SMS
 * link for an onboarding-state council (active row, custom_domain unset —
 * filtered out of the picker) sees the recovery banner AND a list that
 * doesn't contain their council. The banner's promise and the not-listed
 * exit line must read as one coherent journey.
 */
describe('recovery banner + picker composed state', () => {
  it('banner promise and the not-listed exit line render together', () => {
    render(
      <>
        <RecoveryBanner />
        <CouncilPicker
          state={{ kind: 'cards', clients: [OTHER_COUNCIL] }}
        />
      </>,
    )

    // Banner: neutral copy (never asserts "expired") + a real #book anchor.
    expect(
      screen.getByText(/we couldn't open that booking link/i),
    ).toBeInTheDocument()
    const anchor = screen.getByRole('link', { name: /find your council below/i })
    expect(anchor).toHaveAttribute('href', '#book')

    // Picker: the resident's council is absent, so the exit line must guide.
    expect(
      screen.getByText(/if yours isn't listed, check your council's website/i),
    ).toBeInTheDocument()
  })

  it('banner pairs coherently with the unavailable state too', () => {
    render(
      <>
        <RecoveryBanner />
        <CouncilPicker state={{ kind: 'unavailable' }} />
      </>,
    )
    expect(
      screen.getByText(/we couldn't open that booking link/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/temporarily unavailable/i),
    ).toBeInTheDocument()
  })

  it('cards render a single book action and no per-card staff link', () => {
    render(<CouncilPicker state={{ kind: 'cards', clients: [OTHER_COUNCIL] }} />)
    expect(
      screen.getByRole('link', { name: /book a collection/i }),
    ).toHaveAttribute('href', 'https://vvtest.verco.au')
    expect(screen.queryByText(/staff sign in/i)).not.toBeInTheDocument()
  })

  it('renders the member-council serving line for a multi-LGA client', () => {
    render(<CouncilPicker state={{ kind: 'cards', clients: [OTHER_COUNCIL] }} />)
    // Full LGA names (suburb/council disambiguation), sorted by place name.
    expect(
      screen.getByText('Serving Town of Cambridge & City of Fremantle.'),
    ).toBeInTheDocument()
  })

  it('renders no serving line for a single-LGA client', () => {
    const kwn: PickerClient = { ...OTHER_COUNCIL, subClients: [] }
    render(<CouncilPicker state={{ kind: 'cards', clients: [kwn] }} />)
    expect(screen.queryByText(/^Serving /)).not.toBeInTheDocument()
  })
})
