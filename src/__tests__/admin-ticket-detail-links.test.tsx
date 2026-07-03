import { describe, it, expect, vi, beforeAll } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen } from '@testing-library/react'

// jsdom doesn't implement scrollIntoView; the component scrolls the thread
// into view on mount. Stub it so the render doesn't throw.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

// useRouter is called at render by AdminTicketDetailClient.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
// The browser supabase client is constructed at render but only touched inside
// event handlers — a bare stub keeps the component mountable in jsdom.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({}),
}))

import { AdminTicketDetailClient } from '@/app/(admin)/admin/service-tickets/[id]/admin-ticket-detail-client'

/**
 * Regression guards for two service-ticket detail bugs:
 *  1. The "Linked Booking" card linked to /admin/bookings/{ref}, but that route
 *     resolves by UUID and redirects to the list on a miss — so it always
 *     bounced to the bookings list. It must link by the booking's id (UUID).
 *  2. Internal-note / response authors rendered "Unknown". The name now arrives
 *     resolved on the `authorName` prop (server-side, via resolve_actor_names —
 *     covered by audit-resolve-actor-names.test.ts); this asserts the client
 *     renders that name and never the "Unknown" fallback when a name is given.
 */

const baseTicket: ComponentProps<typeof AdminTicketDetailClient>['ticket'] = {
  id: 'ticket-uuid',
  displayId: 'TKT-1001',
  subject: 'Bin not collected',
  message: 'My bin was skipped.',
  status: 'open',
  priority: 'normal',
  category: 'service',
  channel: 'portal',
  assignedTo: null,
  createdAt: '2026-07-03T01:04:00.000Z',
  updatedAt: '2026-07-03T01:04:00.000Z',
  resolvedAt: null,
  closedAt: null,
}

describe('admin service-ticket detail — links & author names', () => {
  it('links the booking card to /admin/bookings/{id} (UUID), not the ref', () => {
    render(
      <AdminTicketDetailClient
        ticket={baseTicket}
        contact={null}
        responses={[]}
        staffUsers={[]}
        linkedBooking={{
          id: '11111111-1111-4111-8111-111111111111',
          ref: 'VV-2026-000123',
          address: '23 Leda Blvd, Wellard WA 6170',
          collectionDate: '2026-07-10',
          services: ['General'],
        }}
        auditLogs={[]}
      />,
    )

    const link = screen.getByRole('link', { name: /VV-2026-000123/ })
    expect(link).toHaveAttribute(
      'href',
      '/admin/bookings/11111111-1111-4111-8111-111111111111',
    )
    // Never the ref — that's what bounced to the list.
    expect(link).not.toHaveAttribute('href', '/admin/bookings/VV-2026-000123')
  })

  it('renders the resolved internal-note author name, not "Unknown"', () => {
    render(
      <AdminTicketDetailClient
        ticket={baseTicket}
        contact={null}
        responses={[
          {
            id: 'note-1',
            authorType: 'staff',
            authorName: 'Daniel Taylor',
            message: 'Closed by Emily Hindle',
            isInternal: true,
            createdAt: '2026-07-03T01:04:00.000Z',
          },
        ]}
        staffUsers={[]}
        linkedBooking={null}
        auditLogs={[]}
      />,
    )

    expect(screen.getByText(/Daniel Taylor/)).toBeInTheDocument()
    expect(screen.queryByText(/Unknown/)).not.toBeInTheDocument()
  })
})
