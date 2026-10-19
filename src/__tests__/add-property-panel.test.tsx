import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  createProperty: vi.fn(),
  invokeEf: vi.fn(),
  onAdded: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/supabase/invoke-ef-client', () => ({ invokeEfWithUserToken: h.invokeEf }))
vi.mock('@/app/(admin)/admin/properties/actions', () => ({ createEligibleProperty: h.createProperty }))

import { AddPropertyPanel } from '@/app/(admin)/admin/properties/add-property-panel'

const areas = [{ id: 'a3', code: 'KWN-3', name: 'Kwinana 3', is_active: true }]

function addProperty(address: string) {
  render(<AddPropertyPanel areas={areas} onAdded={h.onAdded} />)
  fireEvent.change(screen.getByLabelText('Collection area'), { target: { value: 'a3' } })
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: address } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
}

beforeEach(() => {
  h.createProperty.mockReset().mockResolvedValue({ ok: true, data: { property_id: 'new-id' } })
  h.invokeEf.mockReset()
  h.onAdded.mockReset()
})

/**
 * Regression (a hand-added Kwinana property, 15/10/2026): Add Property fired a background
 * "geocode the whole queue" loop instead of geocoding the row it just made, and
 * never said when Google's match was refused. The property sat with no map pin
 * until its booking stalled the OptimoRoute push on 19/10.
 */
describe('AddPropertyPanel', () => {
  it('geocodes exactly the new property and says it is pinned', async () => {
    h.invokeEf.mockResolvedValue({ ok: true, data: { total: 1, processed: 1, failed: 0 } })
    addProperty('7 Fixture Way, Anketell WA 6167')

    expect(await screen.findByText(/pinned on the map/)).toBeInTheDocument()
    expect(h.createProperty).toHaveBeenCalledWith({ collection_area_id: 'a3', address: '7 Fixture Way, Anketell WA 6167' })
    expect(h.invokeEf).toHaveBeenCalledTimes(1)
    expect(h.invokeEf).toHaveBeenCalledWith(expect.anything(), 'geocode-properties', { property_ids: ['new-id'] })
    expect(h.onAdded).toHaveBeenCalled()
  })

  it('keeps the form busy until the map lookup has answered', async () => {
    let answer: (v: unknown) => void = () => {}
    h.invokeEf.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    addProperty('4 Faba Place, Wellard WA 6170')

    expect(await screen.findByRole('button', { name: /Finding the map pin/ })).toBeDisabled()
    answer({ ok: true, data: { total: 1, processed: 1, failed: 0 } })
    expect(await screen.findByRole('button', { name: 'Add' })).toBeEnabled()
  })

  it('says the property has NO map pin when Google’s match was refused, with what Google matched', async () => {
    h.invokeEf.mockResolvedValue({
      ok: true,
      data: {
        total: 1,
        processed: 0,
        failed: 0,
        rejected: 1,
        rejected_samples: [{ id: 'new-id', address: '7 fixture way anketel', google: '7 Fixture Wy, Anketell WA 6167, Australia', reason: 'locality' }],
      },
    })
    addProperty('7 fixture way anketel')

    expect(await screen.findByText(/no map pin/i)).toBeInTheDocument()
    expect(screen.getByText(/7 Fixture Wy, Anketell WA 6167, Australia/)).toBeInTheDocument()
    expect(screen.getByText(/crews’ routes/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Fix the address/ })).toHaveAttribute('href', '/admin/properties/new-id')
  })

  it('says the lookup did not finish, and how to retry, when the geocoder errors', async () => {
    h.invokeEf.mockResolvedValue({ ok: false, error: '{"error":"Google Places API key not configured"}' })
    addProperty('4 Faba Place, Wellard WA 6170')

    expect(await screen.findByText(/no map pin/i)).toBeInTheDocument()
    expect(screen.getByText(/Google Places API key not configured/)).toBeInTheDocument()
    expect(screen.getByText(/Geocode All/)).toBeInTheDocument()
  })

  it('Google finding nothing says to fix the address, not to retry', async () => {
    h.invokeEf.mockResolvedValue({
      ok: false,
      error: JSON.stringify({ total: 1, processed: 0, failed: 1, errors: [{ id: 'new-id', error: 'Geocode: ZERO_RESULTS' }] }),
    })
    addProperty('4 Fabba Plce, Welard')

    expect(await screen.findByText(/no map pin/i)).toBeInTheDocument()
    expect(screen.getByText(/couldn’t find this address/)).toBeInTheDocument()
    expect(screen.queryByText(/Geocode All/)).not.toBeInTheDocument()
  })

  it('a create call that throws shows an error instead of failing silently', async () => {
    h.createProperty.mockRejectedValue(new TypeError('Failed to fetch'))
    addProperty('4 Faba Place, Wellard WA 6170')

    expect(await screen.findByText(/Couldn’t add the property/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
    expect(h.invokeEf).not.toHaveBeenCalled()
  })

  it('shows the create error and never calls the geocoder', async () => {
    h.createProperty.mockResolvedValue({ ok: false, error: 'That address already exists in KWN-3.' })
    addProperty('4 Faba Place, Wellard WA 6170')

    expect(await screen.findByText('That address already exists in KWN-3.')).toBeInTheDocument()
    await waitFor(() => expect(h.invokeEf).not.toHaveBeenCalled())
    expect(h.onAdded).not.toHaveBeenCalled()
  })

  it('does not promise a pin before the lookup has answered', () => {
    render(<AddPropertyPanel areas={areas} onAdded={h.onAdded} />)
    expect(screen.queryByText(/geocoded automatically/)).not.toBeInTheDocument()
  })
})
