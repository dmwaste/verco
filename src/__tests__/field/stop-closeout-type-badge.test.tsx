import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
// 'use server' modules pull in server-only supabase code — mock them so the
// client component mounts in jsdom. None are invoked at render.
vi.mock('@/app/(field)/field/stops/[id]/actions', () => ({
  completeStop: vi.fn(),
  raiseNcnForStop: vi.fn(),
  raiseNpForStop: vi.fn(),
}))
vi.mock('@/app/(field)/field/booking/[ref]/actions', () => ({
  saveMudActualServices: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }))

import {
  StopCloseoutClient,
  type StopDetail,
} from '@/app/(field)/field/stops/[id]/stop-closeout-client'

/**
 * The closeout page has no compile-time link between its PostgREST select and
 * the StopDetail type (the page casts). This render test is the guard that the
 * MUD unit count actually reaches the header badge.
 */
describe('stop closeout header marks MUD and ID jobs', () => {
  const base: StopDetail = {
    id: 'stop-1',
    stream: 'general',
    status: 'Pending',
    address: '12 Strata Way, Mosman Park WA 6012',
    latitude: -32.0,
    longitude: 115.76,
    services_summary: [{ name: 'Bulk Waste', qty: 4 }],
    stop_sequence: 3,
    booking: {
      id: 'b1',
      ref: 'VV-STOP1',
      status: 'Scheduled',
      type: 'Residential',
      location: 'Front Verge',
      notes: null,
      property: null,
      // No items on this stream → the MUD counts gate does not intercept.
      booking_item: [],
    },
  }

  it('a MUD stop shows the MUD badge with the unit count in the header', () => {
    render(
      <StopCloseoutClient
        stop={{ ...base, booking: { ...base.booking, type: 'MUD', property: { unit_count: 38 } } }}
        runHref="/field/runs/2026-06-16/VV-01"
        mattressRequired={false}
      />,
    )
    expect(screen.getByText('MUD · 38 units')).toBeInTheDocument()
    // The pass caption no longer carries the old " · MUD" text suffix.
    expect(screen.getByText('General Pass')).toBeInTheDocument()
  })

  it('an Illegal Dumping stop shows the ID badge', () => {
    render(
      <StopCloseoutClient
        stop={{
          ...base,
          stream: 'illegal_dumping',
          booking: { ...base.booking, type: 'Illegal Dumping', property: null },
        }}
        runHref="/field/runs/2026-06-16/VV-01"
        mattressRequired={false}
      />,
    )
    expect(screen.getByText('ID')).toBeInTheDocument()
  })

  it('a residential stop carries no job-type badge', () => {
    render(
      <StopCloseoutClient stop={base} runHref="/field/runs/2026-06-16/VV-01" mattressRequired={false} />,
    )
    expect(screen.queryByText(/^MUD/)).not.toBeInTheDocument()
    expect(screen.queryByText('ID')).not.toBeInTheDocument()
  })
})
