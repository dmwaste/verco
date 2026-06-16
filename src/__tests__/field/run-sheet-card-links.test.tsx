import { describe, it, expect, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen } from '@testing-library/react'

// useRouter is called at render by both the stops client and useRefreshOnFocus.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
// The per-stop closeout server action ('use server') pulls in server-only
// supabase code — mock it so the client component renders in jsdom. It's only
// invoked on a button click, never at render.
vi.mock('@/app/(field)/field/stops/[id]/actions', () => ({
  completeStop: vi.fn(),
}))

import { RunSheetStopsClient } from '@/app/(field)/field/runs/[date]/[driver]/run-sheet-stops-client'
import { RunSheetClient } from '@/app/(field)/field/run-sheet/run-sheet-client'

/**
 * Regression guard for the field tap-through fix (PR #189). The booking/stop
 * cards were plain divs — the only routes to a detail page were the action
 * buttons, so tapping the booking itself did nothing. The card's info region
 * is now a Link to its detail page; the action buttons must keep their own
 * hrefs (not be hijacked by the card link).
 */

describe('field run cards link through to their detail page', () => {
  it('stop card info region links to /field/stops/[id], NCN/NP keep their own hrefs', () => {
    const stops: ComponentProps<typeof RunSheetStopsClient>['stops'] = [
      {
        id: 'stop-1',
        stream: 'general',
        status: 'Pending',
        address: '23 Leda Blvd, Wellard WA 6170',
        latitude: -32.2,
        longitude: 115.8,
        services_summary: [{ name: 'General', qty: 2 }],
        stop_sequence: 1,
        scheduled_at: '08:30:00',
        driver_serial: 'T-01',
        driver_name: 'Driver A',
        booking: { id: 'b1', ref: 'VV-STOP1', status: 'Scheduled', type: 'Residential' },
      },
    ]

    render(
      <RunSheetStopsClient
        date="2026-06-16"
        driverSerial="T-01"
        stops={stops}
        runMeta={null}
      />,
    )

    // The card info region (the part carrying the ref) is now a tappable link.
    expect(screen.getByRole('link', { name: /VV-STOP1/ })).toHaveAttribute(
      'href',
      '/field/stops/stop-1',
    )
    // Action buttons keep their distinct deep-links — not swallowed by the card.
    expect(screen.getByRole('link', { name: 'NCN' })).toHaveAttribute(
      'href',
      '/field/stops/stop-1?action=ncn',
    )
    expect(screen.getByRole('link', { name: 'NP' })).toHaveAttribute(
      'href',
      '/field/stops/stop-1?action=np',
    )
  })

  it('legacy run-sheet booking card info region links to /field/booking/[ref]', () => {
    const bookings: ComponentProps<typeof RunSheetClient>['bookings'] = [
      {
        id: 'b1',
        ref: 'VV-BK1',
        status: 'Scheduled',
        type: 'Residential',
        location: null,
        notes: null,
        latitude: null,
        longitude: null,
        geo_address: null,
        photos: [],
        id_waste_types: [],
        id_volume: null,
        collection_area: { name: 'KWN-1', code: 'KWN-1' },
        eligible_properties: {
          address: '23 Leda Blvd, Wellard WA 6170',
          formatted_address: '23 Leda Blvd, Wellard WA 6170',
          latitude: null,
          longitude: null,
        },
        booking_item: [
          {
            id: 'i1',
            no_services: 2,
            is_extra: false,
            unit_price_cents: 0,
            actual_services: null,
            service: { name: 'General' },
            collection_date: { date: '2026-06-16' },
          },
        ],
      },
    ]

    render(<RunSheetClient bookings={bookings} />)

    expect(screen.getByRole('link', { name: /VV-BK1/ })).toHaveAttribute(
      'href',
      '/field/booking/VV-BK1',
    )
    expect(screen.getByRole('link', { name: 'NCN' })).toHaveAttribute(
      'href',
      '/field/booking/VV-BK1?action=ncn',
    )
    expect(screen.getByRole('link', { name: 'NP' })).toHaveAttribute(
      'href',
      '/field/booking/VV-BK1?action=np',
    )
  })
})
