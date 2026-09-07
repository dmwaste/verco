import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  updateAddress: vi.fn(),
  moveArea: vi.fn(),
  invokeEf: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/supabase/invoke-ef-client', () => ({ invokeEfWithUserToken: h.invokeEf }))
vi.mock('@/app/(admin)/admin/properties/actions', () => ({
  updateEligiblePropertyAddress: h.updateAddress,
  moveEligiblePropertyArea: h.moveArea,
}))

import { PropertyEditSection } from '@/app/(admin)/admin/properties/[id]/property-edit-section'

const property = {
  id: 'p1',
  address: '12 Smith St, Wellard',
  formatted_address: null,
  has_geocode: true,
  collection_area_id: 'a1',
  collection_area: { id: 'a1', name: 'Kwinana 1', code: 'KWN-1' },
}
const areas = [
  { id: 'a1', name: 'Kwinana 1', code: 'KWN-1' },
  { id: 'a2', name: 'Kwinana 2', code: 'KWN-2' },
]

beforeEach(() => {
  h.updateAddress.mockReset()
  h.moveArea.mockReset()
  h.invokeEf.mockReset()
  h.refresh.mockReset()
})

describe('PropertyEditSection (#502)', () => {
  it('client-admin: area select is disabled with the contractor-only message', () => {
    render(<PropertyEditSection property={property} areas={areas} bookingStatuses={[]} role="client-admin" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Collection area')).toBeDisabled()
    expect(screen.getByText(/Only D&M staff can move/)).toBeInTheDocument()
  })

  it('contractor with upcoming bookings: area move blocked with the live-booking count', () => {
    render(
      <PropertyEditSection property={property} areas={areas} bookingStatuses={['Confirmed', 'Completed', 'Scheduled']} role="contractor-admin" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Collection area')).toBeDisabled()
    expect(screen.getByText(/2 upcoming bookings/)).toBeInTheDocument()
  })

  it('saving a changed address calls the action then re-geocodes exactly that property', async () => {
    h.updateAddress.mockResolvedValue({ ok: true, data: { property_id: 'p1', changed: true } })
    h.invokeEf.mockResolvedValue({ ok: true, data: { processed: 1, failed: 0 } })
    render(<PropertyEditSection property={property} areas={areas} bookingStatuses={[]} role="client-admin" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '12A Smith St, Wellard' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(h.updateAddress).toHaveBeenCalledWith({ property_id: 'p1', address: '12A Smith St, Wellard' }))
    expect(h.invokeEf).toHaveBeenCalledWith(expect.anything(), 'geocode-properties', { property_ids: ['p1'] })
    expect(h.moveArea).not.toHaveBeenCalled()
    await waitFor(() => expect(h.refresh).toHaveBeenCalled())
  })

  // 12 Smith St Perth → Google returned 12 Smith St BEACONSFIELD (VIN-MUD-104):
  // the EF now refuses to write that, and the admin must be told WHY the row is
  // still ungeocoded so they can disambiguate the address (e.g. add the postcode).
  it('tells the admin when the re-geocode was rejected as a different suburb', async () => {
    h.updateAddress.mockResolvedValue({ ok: true, data: { property_id: 'p1', changed: true } })
    h.invokeEf.mockResolvedValue({
      ok: true,
      data: {
        processed: 0,
        failed: 0,
        rejected: 1,
        rejected_samples: [
          { id: 'p1', address: '12 Smith St Perth', google: '12 Smith St, Beaconsfield WA 6162, Australia', reason: 'locality' },
        ],
      },
    })
    render(<PropertyEditSection property={property} areas={areas} bookingStatuses={[]} role="client-admin" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '12 Smith St Perth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(h.invokeEf).toHaveBeenCalled())
    expect(await screen.findByText(/12 Smith St, Beaconsfield WA 6162/)).toBeInTheDocument()
    expect(screen.getByText(/different suburb/)).toBeInTheDocument()
    expect(screen.getByText(/postcode/)).toBeInTheDocument()
  })

  it('contractor moving area (no live bookings) calls moveEligiblePropertyArea', async () => {
    h.moveArea.mockResolvedValue({ ok: true, data: { property_id: 'p1' } })
    render(<PropertyEditSection property={property} areas={areas} bookingStatuses={['Completed']} role="contractor-staff" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Collection area'), { target: { value: 'a2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(h.moveArea).toHaveBeenCalledWith({ property_id: 'p1', collection_area_id: 'a2' }))
    expect(h.updateAddress).not.toHaveBeenCalled()
  })

  it('surfaces a server-side rejection (e.g. duplicate address) without refreshing', async () => {
    h.updateAddress.mockResolvedValue({ ok: false, error: 'That address already exists in KWN-1.' })
    render(<PropertyEditSection property={property} areas={areas} bookingStatuses={[]} role="client-admin" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '14 Smith St, Wellard' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('That address already exists in KWN-1.')).toBeInTheDocument()
    expect(h.refresh).not.toHaveBeenCalled()
  })
})
