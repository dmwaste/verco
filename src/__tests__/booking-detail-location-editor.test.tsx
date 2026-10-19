import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// useRouter/useSearchParams are called at render by the admin BookingDetailClient.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/supabase/invoke-ef-client', () => ({ invokeEfWithUserToken: vi.fn() }))

// The inline Collection Details editor saves notes then location/date.
const updateNotes = vi.fn()
const updateCollectionDetails = vi.fn()
vi.mock('@/app/(admin)/admin/bookings/[id]/actions', () => ({
  confirmBooking: vi.fn(),
  cancelBooking: vi.fn(),
  updateContact: vi.fn(),
  updateBookingQuantities: vi.fn(),
  updateNotes: (...args: unknown[]) => updateNotes(...args),
  updateCollectionDetails: (...args: unknown[]) => updateCollectionDetails(...args),
}))

import { BookingDetailClient } from '@/app/(admin)/admin/bookings/[id]/booking-detail-client'

type Props = ComponentProps<typeof BookingDetailClient>
type Booking = Props['booking']

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'booking-uuid',
    ref: 'KWN-2026-000123',
    status: 'Confirmed',
    type: 'Residential',
    location: 'Front Verge',
    notes: null,
    created_at: '2026-07-01T01:00:00.000Z',
    updated_at: '2026-07-01T01:00:00.000Z',
    property_id: 'prop-uuid',
    collection_area_id: 'area-uuid',
    contact_id: 'contact-uuid',
    client_id: 'client-uuid',
    latitude: null,
    longitude: null,
    geo_address: null,
    photos: [],
    id_waste_types: [],
    id_volume: null,
    collection_area: { name: 'KWN-1', code: 'KWN-1' },
    eligible_properties: { formatted_address: '23 Leda Blvd, Wellard WA 6170', address: '23 Leda Blvd', latitude: -32.2, longitude: 115.8 },
    contact: { first_name: 'Jo', last_name: 'Bloggs', full_name: 'Jo Bloggs', mobile_e164: '+61412345678', email: 'jo@example.com' },
    booking_item: [
      {
        id: 'bi-1',
        service_id: 'svc-general',
        collection_date_id: 'cd-1',
        no_services: 3,
        actual_services: null,
        is_extra: false,
        unit_price_cents: 0,
        updated_at: '2026-07-19T02:03:04.123456+00:00',
        service: { name: 'General' },
        collection_date: { date: '2026-07-20' },
      },
    ],
    ...overrides,
  }
}

function renderDetail(booking: Booking = makeBooking(), userRole: Props['userRole'] = 'contractor-admin') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BookingDetailClient
        booking={booking}
        auditLogs={[]}
        mudContext={null}
        userRole={userRole}
        exceptions={[]}
        tickets={[]}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  updateNotes.mockReset().mockResolvedValue({ ok: true, data: undefined })
  updateCollectionDetails.mockReset().mockResolvedValue({ ok: true, data: undefined })
})

/**
 * Regression guard: staff could not set a booking's location to 'Other' from
 * the admin booking page. The inline editor rendered only the resident
 * LOCATION_OPTIONS, so 'Other' (staff-only, STAFF_LOCATION_OPTION) never
 * appeared, and a booking already on 'Other' opened with no location selected.
 */
describe('admin Collection Details editor — staff-only "Other" location', () => {
  it.each(['contractor-admin', 'client-admin'] as const)('offers "Other" to %s', (role) => {
    renderDetail(makeBooking(), role)
    fireEvent.click(screen.getByLabelText('Edit collection details'))
    expect(screen.getByRole('button', { name: 'Other' })).toBeInTheDocument()
  })

  it('shows a booking already on "Other" as selected', () => {
    renderDetail(makeBooking({ location: 'Other', notes: 'Rear laneway gate' }))
    fireEvent.click(screen.getByLabelText('Edit collection details'))
    expect(screen.getByRole('button', { name: 'Other' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Front Verge' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('requires driver notes for "Other", then saves it', async () => {
    renderDetail()
    fireEvent.click(screen.getByLabelText('Edit collection details'))
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))

    // Same rule as the on-behalf wizard: a free-text location needs explaining.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText(/Notes for driver are required when the location is/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: 'Rear laneway gate' } })
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).not.toBeDisabled()
    fireEvent.click(save)

    await waitFor(() => expect(updateCollectionDetails).toHaveBeenCalledTimes(1))
    expect(updateNotes).toHaveBeenCalledWith('booking-uuid', 'Rear laneway gate')
    expect(updateCollectionDetails).toHaveBeenCalledWith('booking-uuid', {
      location: 'Other',
      collection_date_id: 'cd-1',
    })
  })

  it('does not require notes for the resident locations', () => {
    renderDetail()
    fireEvent.click(screen.getByLabelText('Edit collection details'))
    fireEvent.click(screen.getByRole('button', { name: 'Side Verge' }))
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
  })
})
