import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const rpc = vi.fn()
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }))

import { BookingTallyPanel } from '@/app/(admin)/admin/bookings/booking-tally-panel'

/**
 * The bookings-screen totals panel (VER-323, ADR 0036). Councils check D&M's
 * invoices against it: counts only, no export, Nothing Presented inside the
 * billable subtotal, and a refusal from the RPC shown as an error — never as
 * zeros, which would read as "nothing was collected".
 */

const PAYLOAD = {
  bookings: [
    { status: 'Completed', billable: true, bookings: 10 },
    { status: 'Nothing Presented', billable: true, bookings: 2 },
    { status: 'Cancelled', billable: false, bookings: 4 },
  ],
  units: [
    { source: 'booked', status: 'Completed', billable: true, category: 'bulk', service: 'Bulk Waste', is_extra: false, units: 12 },
    { source: 'booked', status: 'Nothing Presented', billable: true, category: 'bulk', service: 'Bulk Waste', is_extra: false, units: 2 },
    { source: 'booked', status: 'Cancelled', billable: false, category: 'bulk', service: 'Bulk Waste', is_extra: false, units: 4 },
    { source: 'stop_mattress', status: 'Completed', billable: true, units: 3 },
  ],
}

const CLIENT = '11111111-1111-4111-8111-111111111111'
const AREA = '22222222-2222-4222-8222-222222222222'

function renderPanel(overrides: Partial<ComponentProps<typeof BookingTallyPanel>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BookingTallyPanel
        clientId={CLIENT}
        statuses={[]}
        areaIds={[]}
        types={[]}
        serviceIds={[]}
        dateFrom=""
        dateTo=""
        searching={false}
        {...overrides}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ data: PAYLOAD, error: null })
})

describe('BookingTallyPanel', () => {
  it('hides while searching and never calls the RPC with a name or address', () => {
    renderPanel({ searching: true })
    expect(screen.getByText(/Totals are hidden while you search/)).toBeInTheDocument()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('sends only the filters that are set', async () => {
    renderPanel({ statuses: ['Completed', 'Nothing Presented'], areaIds: [AREA], dateFrom: '2026-09-01', dateTo: '2026-09-30' })
    await waitFor(() => expect(rpc).toHaveBeenCalled())
    expect(rpc).toHaveBeenCalledWith('get_booking_tally', {
      p_client_id: CLIENT,
      p_statuses: ['Completed', 'Nothing Presented'],
      p_area_ids: [AREA],
      p_date_from: '2026-09-01',
      p_date_to: '2026-09-30',
    })
  })

  it('shows Nothing Presented inside the billable subtotal and never calls anything non-chargeable', async () => {
    renderPanel()
    const subtotal = await screen.findByRole('rowheader', { name: 'Billable (attended)' })
    const row = subtotal.closest('tr')!
    // bookings 12, Bulk Waste 14, Mattress 3, units 17
    expect(row).toHaveTextContent(/Billable \(attended\)\s*12\s*14\s*3\s*17/)

    const np = screen.getByRole('rowheader', { name: 'Nothing Presented' })
    expect(np.closest('tr')!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(screen.getByRole('rowheader', { name: /Cancelled/ })).toHaveTextContent('not attended')
    expect(document.body.textContent).not.toMatch(/non-?chargeable/i)
    expect(screen.getByText(/Mattress is the crew's count at closeout/)).toBeInTheDocument()
  })

  it('offers no export of any kind', async () => {
    renderPanel()
    await screen.findByRole('rowheader', { name: 'Billable (attended)' })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.body.textContent).not.toMatch(/export|download|csv/i)
  })

  it('shows a refusal as an error, not as zero bookings', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'get_booking_tally: not permitted for this client' } })
    renderPanel()
    expect(await screen.findByRole('alert')).toHaveTextContent('not permitted')
    expect(screen.queryByText(/No bookings match/)).toBeNull()
  })
})
