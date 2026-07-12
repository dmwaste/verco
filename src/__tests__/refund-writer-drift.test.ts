import { describe, it, expect, vi, beforeEach } from 'vitest'
import { REFUND_REASONS, isAutoRaised } from '@/lib/refunds/auto-raised'

/**
 * Non-tautological writer-drift guard for the ONE refund writer that does NOT
 * go through `orchestrateRefund`: the resident self-cancel path
 * ((public)/booking/[ref]/actions.ts), which inserts `refund_request` directly.
 *
 * The four staff orchestrators pass `reason` to `orchestrateRefund`, whose
 * `reason: RefundReason` parameter is a COMPILE-TIME drift guard — an
 * unregistered literal won't type-check. The resident path has no such barrier,
 * so this test drives the real action and asserts the reason it actually writes
 * is one the Refunds page will classify as owed (`isAutoRaised`). A future
 * refactor that swaps the `REFUND_REASONS` reference for a raw string breaks it.
 *
 * (refund-auto-raised.test.ts can't catch this — it checks the classifier
 * against the same constant object it's built from.)
 */

const capturedInserts: Record<string, unknown>[] = []
const invokeSendNotification = vi.fn()

// A far-future collection date so the real cancellation-cutoff check passes.
let booking: {
  id: string
  status: string
  contact_id: string | null
  client_id: string | null
  booking_item: Array<{
    unit_price_cents: number
    no_services: number
    is_extra: boolean
    collection_date: { date: string }
  }>
}

function makeServerClient() {
  return {
    from: (table: string) => {
      if (table === 'booking') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: booking, error: null }) }),
          }),
          update: () => ({
            eq: () => ({
              select: async () => ({ data: [{ id: booking.id }], error: null }),
            }),
          }),
        }
      }
      if (table === 'refund_request') {
        return {
          insert: async (row: Record<string, unknown>) => {
            capturedInserts.push(row)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeServerClient(),
}))
vi.mock('@/lib/notifications/invoke', () => ({
  invokeSendNotification: (...args: unknown[]) => invokeSendNotification(...args),
}))

import { cancelBooking } from '@/app/(public)/booking/[ref]/actions'

beforeEach(() => {
  capturedInserts.length = 0
  invokeSendNotification.mockReset()
  booking = {
    id: 'b-res-1',
    status: 'Confirmed',
    contact_id: 'contact-res-1',
    client_id: 'client-res-1',
    booking_item: [
      // A paid extra → a refund is genuinely owed on cancellation.
      { unit_price_cents: 5000, no_services: 1, is_extra: true, collection_date: { date: '2099-12-31' } },
    ],
  }
})

describe('refund writer-drift — resident self-cancel direct insert', () => {
  it('inserts a refund_request whose reason isAutoRaised() (Refunds page will mark it owed)', async () => {
    const res = await cancelBooking('b-res-1')
    expect(res.ok).toBe(true)

    expect(capturedInserts).toHaveLength(1)
    const reason = capturedInserts[0]?.reason as string
    // Pinned to the registered constant AND independently proven owed-classifiable.
    expect(reason).toBe(REFUND_REASONS.residentCancellation)
    expect(isAutoRaised(reason)).toBe(true)
  })

  it('does not insert a refund_request when there are no paid extras', async () => {
    booking.booking_item = [
      { unit_price_cents: 0, no_services: 2, is_extra: false, collection_date: { date: '2099-12-31' } },
    ]
    const res = await cancelBooking('b-res-1')
    expect(res.ok).toBe(true)
    expect(capturedInserts).toHaveLength(0)
  })
})
