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

// The inline quantity editor calls updateBookingQuantities on Save; the other
// actions are mocked so the ('use server') module doesn't pull server-only code.
const updateBookingQuantities = vi.fn()
vi.mock('@/app/(admin)/admin/bookings/[id]/actions', () => ({
  confirmBooking: vi.fn(),
  cancelBooking: vi.fn(),
  updateContact: vi.fn(),
  updateCollectionDetails: vi.fn(),
  updateNotes: vi.fn(),
  updateBookingQuantities: (...args: unknown[]) => updateBookingQuantities(...args),
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
    latitude: null,
    longitude: null,
    geo_address: null,
    photos: [],
    id_waste_types: [],
    id_volume: null,
    collection_area: { name: 'KWN-1', code: 'KWN-1' },
    eligible_properties: { formatted_address: '23 Leda Blvd, Wellard WA 6170', address: '23 Leda Blvd' },
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
        service: { name: 'General' },
        collection_date: { date: '2026-07-20' },
      },
    ],
    ...overrides,
  }
}

function renderDetail(props: Partial<Props> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BookingDetailClient
        booking={props.booking ?? makeBooking()}
        auditLogs={[]}
        mudContext={props.mudContext ?? null}
        userRole={props.userRole ?? 'contractor-admin'}
        exceptions={[]}
        tickets={[]}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  updateBookingQuantities.mockReset()
  updateBookingQuantities.mockResolvedValue({ ok: true, data: { refundOwedCents: 0 } })
})

describe('inline quantity editor — gating', () => {
  it('offers the quantity editor on a Confirmed non-MUD booking (admin role)', () => {
    renderDetail()
    expect(screen.getByLabelText('Edit quantities')).toBeInTheDocument()
  })

  it('hides the quantity editor on a Pending Payment booking (unpaid / open session)', () => {
    renderDetail({ booking: makeBooking({ status: 'Pending Payment' }) })
    expect(screen.queryByLabelText('Edit quantities')).not.toBeInTheDocument()
  })

  it('hides the quantity editor on a MUD booking (per-FY cap double-spend risk)', () => {
    renderDetail({
      booking: makeBooking({ type: 'MUD' }),
      mudContext: {
        propertyId: 'prop-uuid', mudCode: 'MUD-1', unitCount: 8,
        onboardingStatus: 'Registered', strataContact: null, allowance: [],
      } as Props['mudContext'],
    })
    expect(screen.queryByLabelText('Edit quantities')).not.toBeInTheDocument()
  })

  it('hides the quantity editor for a non-admin role (ranger)', () => {
    renderDetail({ userRole: 'ranger' })
    expect(screen.queryByLabelText('Edit quantities')).not.toBeInTheDocument()
  })
})

describe('inline quantity editor — interaction', () => {
  it('Save is disabled until a quantity changes, then reduces and calls the action with the same date', async () => {
    renderDetail()
    fireEvent.click(screen.getByLabelText('Edit quantities'))

    // Save disabled while unchanged.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    // Reduce General 3 → 2.
    fireEvent.click(screen.getByLabelText('Decrease General'))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).not.toBeDisabled()

    fireEvent.click(save)

    await waitFor(() => expect(updateBookingQuantities).toHaveBeenCalledTimes(1))
    // items = the TARGET (2); expectedItems = the ORIGINAL rendered qty (3) — the
    // #387.1 concurrency baseline. The baseline must be the original, never the
    // reduced draft, or the RPC guard would 409 every legitimate reduction.
    expect(updateBookingQuantities).toHaveBeenCalledWith(
      'booking-uuid',
      [{ service_id: 'svc-general', no_services: 2 }],
      [{ service_id: 'svc-general', no_services: 3 }],
    )
  })

  it('cannot decrement a service below 1 (removal = cancel & rebook)', () => {
    renderDetail({
      booking: makeBooking({
        booking_item: [
          { id: 'bi-1', service_id: 'svc-general', collection_date_id: 'cd-1', no_services: 1, actual_services: null, is_extra: false, unit_price_cents: 0, service: { name: 'General' }, collection_date: { date: '2026-07-20' } },
        ],
      }),
    })
    fireEvent.click(screen.getByLabelText('Edit quantities'))
    expect(screen.getByLabelText('Decrease General')).toBeDisabled()
  })

  it('surfaces a server block (e.g. drift / requires payment) as an error', async () => {
    updateBookingQuantities.mockResolvedValue({
      ok: false,
      error: 'Increasing the quantity adds a paid extra. Cancel and rebook to add paid services.',
    })
    renderDetail()
    fireEvent.click(screen.getByLabelText('Edit quantities'))
    fireEvent.click(screen.getByLabelText('Decrease General'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Cancel and rebook to add paid services/),
    )
  })
})
