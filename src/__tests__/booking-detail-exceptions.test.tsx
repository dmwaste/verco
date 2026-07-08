import { describe, it, expect, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen } from '@testing-library/react'

// useRouter is called at render by BookingDetailClient.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
// The browser supabase client is constructed at render but only touched inside
// event handlers — a bare stub keeps the component mountable in jsdom.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({}),
}))
// The dispute/cancel server actions ('use server') pull in server-only supabase
// code — mock them so the client renders in jsdom. Only invoked on click.
vi.mock('@/app/(public)/booking/[ref]/actions', () => ({
  cancelBooking: vi.fn(),
  disputeNcn: vi.fn(),
  disputeNp: vi.fn(),
}))

import { BookingDetailClient } from '@/app/(public)/booking/[ref]/booking-detail-client'

/**
 * Regression guard: a booking can carry MULTIPLE notice records — one per stop
 * (waste stream), even both an NCN and an NP. The resident detail page fetched
 * these with `.maybeSingle()`, which errors (data → null) when >1 row exists, so
 * the resident saw NO exception card despite having exceptions. Props are now
 * arrays and every record renders its own white-label card.
 */

const baseBooking: ComponentProps<typeof BookingDetailClient>['booking'] = {
  id: 'booking-uuid',
  ref: 'VV-2026-000123',
  status: 'Non-conformance',
  type: 'residential',
  location: 'Front Verge',
  notes: null,
  created_at: '2026-07-01T01:00:00.000Z',
  property_id: 'prop-uuid',
  collection_area_id: 'area-uuid',
  collection_area: { name: 'VV-COT' },
  contact: null,
  property: { formatted_address: '23 Leda Blvd, Wellard WA 6170', address: '23 Leda Blvd' },
  booking_item: [],
}

describe('resident booking detail — multi-record exceptions', () => {
  it('renders one NCN card per record when a booking has multiple NCNs', () => {
    render(
      <BookingDetailClient
        booking={baseBooking}
        tickets={[]}
        receiptUrl={null}
        ncn={[
          {
            id: 'ncn-general',
            reason: 'Bin overloaded',
            status: 'Issued',
            photos: [],
            reported_at: '2026-07-05T02:00:00.000Z',
            serviceLabel: 'Bulk Waste',
            rescheduled_booking: null,
          },
          {
            id: 'ncn-green',
            reason: 'Prohibited items in green waste',
            status: 'Issued',
            photos: [],
            reported_at: '2026-07-04T02:00:00.000Z',
            serviceLabel: 'Green Waste',
            rescheduled_booking: null,
          },
        ]}
        np={[]}
        placeOutHoursBefore={72}
        serviceName={null}
      />,
    )

    expect(screen.getAllByText('Non-Conformance Notice')).toHaveLength(2)
    expect(screen.getByText('Bin overloaded')).toBeInTheDocument()
    expect(screen.getByText('Prohibited items in green waste')).toBeInTheDocument()
    // Each card names the booked service it applies to.
    expect(screen.getAllByText('Service type')).toHaveLength(2)
    expect(screen.getByText('Bulk Waste')).toBeInTheDocument()
    expect(screen.getByText('Green Waste')).toBeInTheDocument()
    // Each Issued record gets its own dispute button.
    expect(screen.getAllByRole('button', { name: /Dispute this Notice/ })).toHaveLength(2)
  })

  it('renders both an NCN and an NP card when a booking has both', () => {
    render(
      <BookingDetailClient
        booking={baseBooking}
        tickets={[]}
        receiptUrl={null}
        ncn={[
          {
            id: 'ncn-general',
            reason: 'Bin overloaded',
            status: 'Issued',
            photos: [],
            reported_at: '2026-07-05T02:00:00.000Z',
            serviceLabel: 'Bulk Waste',
            rescheduled_booking: null,
          },
        ]}
        np={[
          {
            id: 'np-green',
            status: 'Issued',
            photos: [],
            reported_at: '2026-07-05T02:00:00.000Z',
            contractor_fault: false,
            serviceLabel: 'Green Waste',
            rescheduled_booking: null,
          },
        ]}
        placeOutHoursBefore={72}
        serviceName={null}
      />,
    )

    expect(screen.getByText('Non-Conformance Notice')).toBeInTheDocument()
    expect(screen.getByText('Nothing Presented')).toBeInTheDocument()
    expect(screen.getByText('Bin overloaded')).toBeInTheDocument()
  })
})
