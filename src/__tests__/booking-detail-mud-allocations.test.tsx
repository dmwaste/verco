import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * MUD collected-count editor on the admin booking detail page (2026-09-01).
 *
 * Contractor staff correct booking_item.actual_services after collection —
 * the counts crews enter on the closeout "Allocation Entry" screen, which
 * drive council invoicing. The pencil renders only for contractor tier on
 * post-collection statuses; Save sends changed items ONLY, each carrying the
 * page-rendered booking_item.updated_at token verbatim.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/supabase/invoke-ef-client', () => ({ invokeEfWithUserToken: vi.fn() }))

const updateMudAllocations = vi.fn()
vi.mock('@/app/(admin)/admin/bookings/[id]/actions', () => ({
  confirmBooking: vi.fn(),
  cancelBooking: vi.fn(),
  updateContact: vi.fn(),
  updateCollectionDetails: vi.fn(),
  updateIdDetails: vi.fn(),
  updateNotes: vi.fn(),
  updateBookingQuantities: vi.fn(),
  updateMudAllocations: (...args: unknown[]) => updateMudAllocations(...args),
}))

import { BookingDetailClient } from '@/app/(admin)/admin/bookings/[id]/booking-detail-client'

type Props = ComponentProps<typeof BookingDetailClient>
type Booking = Props['booking']

const TOKEN_GENERAL = '2026-08-30T02:03:04.123456+00:00'
const TOKEN_GREEN = '2026-08-30T02:03:05.654321+00:00'

function makeMudBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'booking-uuid',
    ref: 'VV-2026-000456',
    status: 'Completed',
    type: 'MUD',
    location: 'Front Verge',
    notes: null,
    created_at: '2026-08-01T01:00:00.000Z',
    updated_at: '2026-08-01T01:00:00.000Z',
    property_id: 'prop-uuid',
    collection_area_id: 'area-uuid',
    contact_id: 'contact-uuid',
    client_id: 'client-uuid',
    fy_id: 'fy-uuid',
    latitude: null,
    longitude: null,
    geo_address: null,
    photos: [],
    id_waste_types: [],
    id_volume: null,
    collection_area: { name: 'VV-COT', code: 'VV-COT' },
    eligible_properties: { formatted_address: '1/20 Strata Way, Coogee WA 6166', address: '1/20 Strata Way' },
    contact: { first_name: 'Sam', last_name: 'Strata', full_name: 'Sam Strata', mobile_e164: '+61412345678', email: 'sam@example.com' },
    booking_item: [
      {
        id: 'bi-general',
        service_id: 'svc-general',
        collection_date_id: 'cd-1',
        no_services: 2,
        actual_services: 6,
        is_extra: false,
        unit_price_cents: 0,
        updated_at: TOKEN_GENERAL,
        service: { name: 'General' },
        collection_date: { date: '2026-08-28' },
      },
      {
        id: 'bi-green',
        service_id: 'svc-green',
        collection_date_id: 'cd-1',
        no_services: 2,
        actual_services: 2,
        is_extra: false,
        unit_price_cents: 0,
        updated_at: TOKEN_GREEN,
        service: { name: 'Green' },
        collection_date: { date: '2026-08-28' },
      },
    ],
    ...overrides,
  } as Booking
}

const MUD_CONTEXT = {
  propertyId: 'prop-uuid',
  mudCode: 'MUD-1',
  unitCount: 12,
  onboardingStatus: 'Registered',
  strataContact: null,
  allowance: [],
} as Props['mudContext']

function renderDetail(props: Partial<Props> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BookingDetailClient
        booking={props.booking ?? makeMudBooking()}
        auditLogs={[]}
        mudContext={props.mudContext ?? MUD_CONTEXT}
        userRole={props.userRole ?? 'contractor-admin'}
        exceptions={[]}
        tickets={[]}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  updateMudAllocations.mockReset()
  updateMudAllocations.mockResolvedValue({ ok: true, data: undefined })
})

describe('MUD collected-count editor — gating', () => {
  it('offers the editor to contractor staff on a Completed MUD booking', () => {
    renderDetail()
    expect(screen.getByLabelText('Edit collected counts')).toBeInTheDocument()
  })

  it('offers the editor on Non-conformance and Nothing Presented (billable per ADR 0017)', () => {
    for (const status of ['Non-conformance', 'Nothing Presented'] as const) {
      const view = renderDetail({ booking: makeMudBooking({ status }) })
      expect(screen.getByLabelText('Edit collected counts')).toBeInTheDocument()
      view.unmount()
    }
  })

  it('hides the editor from client-tier roles (read-only chips stay)', () => {
    renderDetail({ userRole: 'client-admin' })
    expect(screen.queryByLabelText('Edit collected counts')).not.toBeInTheDocument()
    expect(screen.getByText('6 collected')).toBeInTheDocument()
  })

  it('hides the editor while Scheduled — the crew still owns the counts', () => {
    renderDetail({ booking: makeMudBooking({ status: 'Scheduled' }) })
    expect(screen.queryByLabelText('Edit collected counts')).not.toBeInTheDocument()
  })

  it('never renders on a non-MUD booking', () => {
    renderDetail({ booking: makeMudBooking({ type: 'Residential' }), mudContext: null })
    expect(screen.queryByLabelText('Edit collected counts')).not.toBeInTheDocument()
  })
})

describe('MUD collected-count editor — interaction', () => {
  it('Save stays disabled until a count changes, then sends ONLY the changed item with its verbatim token', async () => {
    renderDetail()
    fireEvent.click(screen.getByLabelText('Edit collected counts'))

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    // Correct the mis-allocation: General 6 → 5.
    fireEvent.click(screen.getByLabelText('Decrease General collected count'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(updateMudAllocations).toHaveBeenCalledWith('booking-uuid', [
        { booking_item_id: 'bi-general', actual_services: 5, expected_updated_at: TOKEN_GENERAL },
      ]),
    )
    expect(await screen.findByText('Collected counts updated.')).toBeInTheDocument()
  })

  it('a touched count returned to its original value is excluded again (no empty audit rows)', () => {
    renderDetail()
    fireEvent.click(screen.getByLabelText('Edit collected counts'))
    fireEvent.click(screen.getByLabelText('Decrease General collected count'))
    fireEvent.click(screen.getByLabelText('Increase General collected count'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('surfaces a stale-token conflict as an error', async () => {
    updateMudAllocations.mockResolvedValue({
      ok: false,
      error: 'This booking changed while you were editing — reload the page and re-apply your changes.',
    })
    renderDetail()
    fireEvent.click(screen.getByLabelText('Edit collected counts'))
    fireEvent.click(screen.getByLabelText('Decrease General collected count'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(
      await screen.findByText(/changed while you were editing/),
    ).toBeInTheDocument()
  })
})
