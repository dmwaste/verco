import { describe, it, expect, vi, beforeEach } from 'vitest'

// Integration test for the updateBookingQuantities server action (issue #380).
// Exercises the real orchestration — booking read, EF call, and the refund
// hand-off to the existing refund_request + process-refund machinery — with the
// supabase client and fetch mocked. Complements the pure evaluateQuantityEdit
// unit tests (BR review #4 asked for an integration-level reduce → refund test).

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ getAll: () => [] }),
}))

// Test-controlled state.
let role = 'contractor-admin'
let booking: Record<string, unknown> | null
let swapRow: { id: string } | null = null
const refundInserts: Array<Record<string, unknown>> = []

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: (name: string) =>
      name === 'current_user_role'
        ? Promise.resolve({ data: role })
        : Promise.resolve({ data: null }),
    auth: {
      getSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }),
    },
    from: (table: string) => {
      if (table === 'booking') {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: booking, error: booking ? null : { message: 'not found' } }) }) }),
        }
      }
      if (table === 'allocation_swap') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: swapRow }) }) }),
        }
      }
      if (table === 'refund_request') {
        return {
          insert: (row: Record<string, unknown>) => {
            refundInserts.push(row)
            return { select: () => ({ single: () => Promise.resolve({ data: { id: 'refund-1' }, error: null }) }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { updateBookingQuantities } from '@/app/(admin)/admin/bookings/[id]/actions'

interface FetchCall { url: string; body: Record<string, unknown> }
let fetchCalls: FetchCall[] = []
let efResponse: { ok: boolean; status?: number; payload: Record<string, unknown> }

beforeEach(() => {
  role = 'contractor-admin'
  swapRow = null
  refundInserts.length = 0
  fetchCalls = []
  efResponse = { ok: true, payload: { booking_id: 'b1', ref: 'KWN-1', requires_payment: false, edited: true, refund_owed_cents: 5000 } }
  booking = {
    id: 'b1', status: 'Confirmed', type: 'Residential', location: 'Front Verge',
    property_id: 'prop-1', collection_area_id: 'area-1', contact_id: 'c1', client_id: 'client-1',
    booking_item: [{ collection_date_id: 'cd-1' }],
  }
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) })
    if (url.includes('/create-booking')) {
      return { ok: efResponse.ok, status: efResponse.status ?? 200, text: async () => JSON.stringify(efResponse.payload), json: async () => efResponse.payload }
    }
    // process-refund
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
  })
})

const REDUCE = [{ service_id: 'svc-general', no_services: 1 }]

describe('updateBookingQuantities — reduction → refund orchestration', () => {
  it('calls the EF with inline_edit + replaces + items and NO contact, then refunds via the existing machinery', async () => {
    const res = await updateBookingQuantities('b1', REDUCE)
    expect(res).toEqual({ ok: true, data: { refundOwedCents: 5000 } })

    const efCall = fetchCalls.find((c) => c.url.includes('/create-booking'))!
    expect(efCall.body.inline_edit).toBe(true)
    expect(efCall.body.replaces).toBe('b1')
    expect(efCall.body.collection_date_id).toBe('cd-1')
    expect(efCall.body.items).toEqual(REDUCE)
    expect('contact' in efCall.body).toBe(false) // inline editor omits contact

    // Refund hand-off: one Pending refund_request for the owed amount + process-refund fired.
    expect(refundInserts).toHaveLength(1)
    expect(refundInserts[0]).toMatchObject({ booking_id: 'b1', amount_cents: 5000, status: 'Pending' })
    const refundCall = fetchCalls.find((c) => c.url.includes('/process-refund'))!
    expect(refundCall.body.refund_request_id).toBe('refund-1')
  })

  it('re-sends the booking allocation swap when present (so the EF does not strip it)', async () => {
    swapRow = { id: 'swap-1' }
    await updateBookingQuantities('b1', REDUCE)
    const efCall = fetchCalls.find((c) => c.url.includes('/create-booking'))!
    expect(efCall.body.swap).toBe(true)
  })

  it('does NOT refund when the EF reports refund_owed_cents = 0 (free-quota change)', async () => {
    efResponse.payload.refund_owed_cents = 0
    const res = await updateBookingQuantities('b1', [{ service_id: 'svc-general', no_services: 2 }])
    expect(res).toEqual({ ok: true, data: { refundOwedCents: 0 } })
    expect(refundInserts).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.includes('/process-refund'))).toBe(false)
  })

  it('surfaces an EF block (drift / requires payment) as an error and does not refund', async () => {
    efResponse = { ok: false, status: 409, payload: { error: 'Increasing the quantity adds a paid extra. Cancel and rebook to add paid services.', code: 'requires_payment' } }
    const res = await updateBookingQuantities('b1', [{ service_id: 'svc-general', no_services: 5 }])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Cancel and rebook to add paid services/)
    expect(refundInserts).toHaveLength(0)
  })
})

describe('updateBookingQuantities — gating (server re-enforces the UI gate)', () => {
  it('rejects a MUD booking before calling the EF', async () => {
    booking!.type = 'MUD'
    const res = await updateBookingQuantities('b1', REDUCE)
    expect(res.ok).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it('rejects a non-Confirmed booking (Pending Payment) before calling the EF', async () => {
    booking!.status = 'Pending Payment'
    const res = await updateBookingQuantities('b1', REDUCE)
    expect(res.ok).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it('rejects a non-admin role', async () => {
    role = 'ranger'
    const res = await updateBookingQuantities('b1', REDUCE)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/permission/i)
  })

  it('rejects an empty item set (removal = cancel & rebook)', async () => {
    const res = await updateBookingQuantities('b1', [{ service_id: 'svc-general', no_services: 0 }])
    expect(res.ok).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })
})
