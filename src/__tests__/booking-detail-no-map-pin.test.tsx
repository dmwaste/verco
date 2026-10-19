import { describe, it, expect, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/supabase/invoke-ef-client', () => ({ invokeEfWithUserToken: vi.fn() }))
vi.mock('@/app/(admin)/admin/bookings/[id]/actions', () => ({
  confirmBooking: vi.fn(),
  cancelBooking: vi.fn(),
  updateContact: vi.fn(),
  updateBookingQuantities: vi.fn(),
  updateNotes: vi.fn(),
  updateCollectionDetails: vi.fn(),
}))

import { BookingDetailClient } from '@/app/(admin)/admin/bookings/[id]/booking-detail-client'

type Props = ComponentProps<typeof BookingDetailClient>
type Booking = Props['booking']

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'booking-uuid',
    ref: 'KWN-4-TEST01',
    status: 'Confirmed',
    type: 'Residential',
    location: 'Front Verge',
    notes: null,
    created_at: '2026-10-15T01:45:00.000Z',
    updated_at: '2026-10-15T01:45:00.000Z',
    property_id: 'prop-uuid',
    collection_area_id: 'area-uuid',
    contact_id: null,
    client_id: 'client-uuid',
    latitude: null,
    longitude: null,
    geo_address: null,
    photos: [],
    id_waste_types: [],
    id_volume: null,
    collection_area: { name: 'Kwinana 4', code: 'KWN-4' },
    eligible_properties: { formatted_address: null, address: '7 fixture way anketel', latitude: null, longitude: null },
    contact: null,
    booking_item: [],
    ...overrides,
  }
}

function renderDetail(booking: Booking) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BookingDetailClient
        booking={booking}
        auditLogs={[]}
        mudContext={null}
        userRole="contractor-admin"
        exceptions={[]}
        tickets={[]}
      />
    </QueryClientProvider>,
  )
}

/**
 * A Kwinana booking (collection 22/10/2026) was made on a property with no map
 * pin. Nothing on the booking said so; the OptimoRoute push was the first place
 * it surfaced, three days out (19/10). Staff looking at the booking must see it.
 */
describe('admin booking detail: property with no map pin', () => {
  it('warns on an upcoming booking and links to the property to fix it', () => {
    renderDetail(makeBooking())
    expect(screen.getByText(/no map pin/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Fix the address/ })).toHaveAttribute('href', '/admin/properties/prop-uuid')
  })

  it('stays quiet when the property is pinned', () => {
    renderDetail(makeBooking({
      eligible_properties: { formatted_address: '7 Fixture Wy, Anketell WA 6167, Australia', address: '7 Fixture Way, Anketell', latitude: -32.2, longitude: 115.85 },
    }))
    expect(screen.queryByText(/no map pin/i)).not.toBeInTheDocument()
  })

  // The push falls back to the booking's own pin when the property has none
  // (stopLocation, legacy Airtable imports): that stop IS routable.
  it('stays quiet when the booking carries its own pin', () => {
    renderDetail(makeBooking({ latitude: -31.95, longitude: 115.86 }))
    expect(screen.queryByText(/no map pin/i)).not.toBeInTheDocument()
  })

  it('stays quiet once the collection is over', () => {
    renderDetail(makeBooking({ status: 'Completed' }))
    expect(screen.queryByText(/no map pin/i)).not.toBeInTheDocument()
  })
})
