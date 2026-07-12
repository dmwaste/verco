import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The refund half of a quantity reduction hands the resident notification a
 * `refund_status` (mapped from orchestrateRefund's outcome) + the
 * `refund_request_id` (never a cents figure — send-notification derives the
 * displayed amount from the row). This pins the action's notify-body glue:
 *
 *   ...(refundStatus && refundRequestId ? { refund_status, refund_request_id } : {})
 *
 * so a '-staff' reduction that lands 'queued' still tells the resident a refund
 * is pending — and a 'failed'/'none' outcome never claims a refund is coming.
 */

const invokeSendNotification = vi.fn()
const orchestrateRefund = vi.fn()

const BOOKING_ID = '9a1f6f2e-1c6b-4a1e-9f7d-2b8c3d4e5f60'
const SERVICE_ID = '5e0c9b8a-7d6f-4c3b-a291-8f7e6d5c4b3a'

let refundOwedCents: number

function makeAdminClient() {
  return {
    rpc: async (fn: string) =>
      fn === 'current_user_role'
        ? { data: 'contractor-admin', error: null }
        : { data: null, error: null },
    from: (table: string) => {
      if (table === 'booking') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: BOOKING_ID,
                  status: 'Confirmed',
                  type: 'Residential',
                  location: 'Front Verge',
                  property_id: 'prop-1',
                  collection_area_id: 'area-1',
                  contact_id: 'contact-1',
                  client_id: 'client-1',
                  booking_item: [{ collection_date_id: 'cd-1' }],
                },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'allocation_swap') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeAdminClient() }))
vi.mock('@/lib/notifications/invoke', () => ({
  invokeSendNotification: (...args: unknown[]) => invokeSendNotification(...args),
}))
vi.mock('@/lib/payments/orchestrate-refund', () => ({
  orchestrateRefund: (...args: unknown[]) => orchestrateRefund(...args),
}))

import { updateBookingQuantities } from '@/app/(admin)/admin/bookings/[id]/actions'

beforeEach(() => {
  invokeSendNotification.mockReset()
  orchestrateRefund.mockReset()
  refundOwedCents = 5000
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    json: async () => ({ refund_owed_cents: refundOwedCents }),
    text: async () => '',
  }))
})

describe('updateBookingQuantities — refund notify body', () => {
  it("a 'queued' reduction notifies with refund_status 'pending_review' + refund_request_id", async () => {
    orchestrateRefund.mockResolvedValue({ state: 'queued', refundRequestId: 'rr-q1' })

    const res = await updateBookingQuantities(BOOKING_ID, [{ service_id: SERVICE_ID, no_services: 2 }])

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.refundState).toBe('queued')

    expect(invokeSendNotification).toHaveBeenCalledTimes(1)
    expect(invokeSendNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'booking_updated',
        booking_id: BOOKING_ID,
        refund_status: 'pending_review',
        refund_request_id: 'rr-q1',
      }),
    )
  })

  it("a 'failed' reduction never claims a refund — no refund_status / refund_request_id in the body", async () => {
    orchestrateRefund.mockResolvedValue({ state: 'failed' })

    const res = await updateBookingQuantities(BOOKING_ID, [{ service_id: SERVICE_ID, no_services: 2 }])

    expect(res.ok).toBe(true)
    expect(invokeSendNotification).toHaveBeenCalledTimes(1)
    const body = invokeSendNotification.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body).not.toHaveProperty('refund_status')
    expect(body).not.toHaveProperty('refund_request_id')
  })
})
