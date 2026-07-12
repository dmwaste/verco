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
let swapError: { message: string } | null = null
let refundInsertError: { message: string } | null = null
let processRefundOk = true
const refundInserts: Array<Record<string, unknown>> = []

// Valid UUIDs — the action zod-validates bookingId + service_id shapes.
const B1 = '9a1f6f2e-1c6b-4a1e-9f7d-2b8c3d4e5f60'
const SVC_GENERAL = '5e0c9b8a-7d6f-4c3b-a291-8f7e6d5c4b3a'

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
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: swapRow, error: swapError }) }) }),
        }
      }
      if (table === 'refund_request') {
        return {
          insert: (row: Record<string, unknown>) => {
            if (!refundInsertError) refundInserts.push(row)
            return {
              select: () => ({
                single: () =>
                  Promise.resolve(
                    refundInsertError
                      ? { data: null, error: refundInsertError }
                      : { data: { id: 'refund-1' }, error: null },
                  ),
              }),
            }
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
  swapError = null
  refundInsertError = null
  processRefundOk = true
  refundInserts.length = 0
  fetchCalls = []
  efResponse = { ok: true, payload: { booking_id: B1, ref: 'KWN-1', requires_payment: false, edited: true, refund_owed_cents: 5000 } }
  booking = {
    id: B1, status: 'Confirmed', type: 'Residential', location: 'Front Verge',
    property_id: 'prop-1', collection_area_id: 'area-1', contact_id: 'c1', client_id: 'client-1',
    booking_item: [{ collection_date_id: 'cd-1' }],
  }
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) })
    if (url.includes('/create-booking')) {
      return { ok: efResponse.ok, status: efResponse.status ?? 200, text: async () => JSON.stringify(efResponse.payload), json: async () => efResponse.payload }
    }
    // process-refund
    return {
      ok: processRefundOk,
      status: processRefundOk ? 200 : 403,
      text: async () => (processRefundOk ? '{}' : '{"error":"Insufficient permissions"}'),
      json: async () => ({}),
    }
  })
})

const REDUCE = [{ service_id: SVC_GENERAL, no_services: 1 }]
// The ORIGINAL rendered quantity the admin saw when the editor opened (#387.1
// view-to-write guard baseline). Distinct from REDUCE (the target) so the tests
// prove the action forwards the baseline, not the draft.
const EXPECTED = [{ service_id: SVC_GENERAL, no_services: 3 }]

describe('updateBookingQuantities — reduction → refund orchestration', () => {
  it('forwards the RENDERED baseline as expected_items so the RPC guard covers the full view-to-write window', async () => {
    await updateBookingQuantities(B1, REDUCE, EXPECTED)
    const efCall = fetchCalls.find((c) => c.url.includes('/create-booking'))!
    // The concurrency precondition must be the admin's original (rendered) set,
    // NOT the reduced target — else the guard would 409 every legitimate edit.
    expect(efCall.body.expected_items).toEqual(EXPECTED)
    expect(efCall.body.items).toEqual(REDUCE)
  })

  it('calls the EF with inline_edit + replaces + items and NO contact, then refunds via the existing machinery', async () => {
    const res = await updateBookingQuantities(B1, REDUCE, EXPECTED)
    expect(res).toEqual({ ok: true, data: { refundOwedCents: 5000, refundState: 'initiated' } })

    const efCall = fetchCalls.find((c) => c.url.includes('/create-booking'))!
    expect(efCall.body.inline_edit).toBe(true)
    expect(efCall.body.replaces).toBe(B1)
    expect(efCall.body.collection_date_id).toBe('cd-1')
    expect(efCall.body.items).toEqual(REDUCE)
    expect('contact' in efCall.body).toBe(false) // inline editor omits contact

    // Refund hand-off: one Pending refund_request for the owed amount + process-refund fired.
    expect(refundInserts).toHaveLength(1)
    expect(refundInserts[0]).toMatchObject({ booking_id: B1, amount_cents: 5000, status: 'Pending' })
    const refundCall = fetchCalls.find((c) => c.url.includes('/process-refund'))!
    expect(refundCall.body.refund_request_id).toBe('refund-1')

    // booking_updated notification carries the refund_request_id (opaque
    // identity) + status — NEVER a caller-supplied amount. send-notification
    // derives the displayed cents from the refund_request row so it can't be
    // forged (money-integrity hardening, deferred item from the refund review).
    const notifyCall = fetchCalls.find((c) => c.url.includes('/send-notification'))!
    expect(notifyCall.body.type).toBe('booking_updated')
    expect(notifyCall.body.refund_request_id).toBe('refund-1')
    expect(notifyCall.body.refund_status).toBe('processed')
    expect('refund_cents' in notifyCall.body).toBe(false)
  })

  it('re-sends the booking allocation swap when present (so the EF does not strip it)', async () => {
    swapRow = { id: 'swap-1' }
    await updateBookingQuantities(B1, REDUCE, EXPECTED)
    const efCall = fetchCalls.find((c) => c.url.includes('/create-booking'))!
    expect(efCall.body.swap).toBe(true)
  })

  it('does NOT refund when the EF reports refund_owed_cents = 0 (free-quota change)', async () => {
    efResponse.payload.refund_owed_cents = 0
    const res = await updateBookingQuantities(B1, [{ service_id: SVC_GENERAL, no_services: 2 }], EXPECTED)
    expect(res).toEqual({ ok: true, data: { refundOwedCents: 0, refundState: 'none' } })
    expect(refundInserts).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.includes('/process-refund'))).toBe(false)
  })

  it("returns refundState 'failed' when the refund_request insert is rejected (no Pending row to retry)", async () => {
    refundInsertError = { message: 'RLS denied' }
    const res = await updateBookingQuantities(B1, REDUCE, EXPECTED)
    expect(res).toEqual({ ok: true, data: { refundOwedCents: 5000, refundState: 'failed' } })
    expect(fetchCalls.some((c) => c.url.includes('/process-refund'))).toBe(false)
  })

  it("returns refundState 'queued' when process-refund declines (e.g. -staff role, approval-tier EF)", async () => {
    processRefundOk = false
    const res = await updateBookingQuantities(B1, REDUCE, EXPECTED)
    expect(res).toEqual({ ok: true, data: { refundOwedCents: 5000, refundState: 'queued' } })
    // The Pending refund_request row exists — recoverable from the Refunds page.
    expect(refundInserts).toHaveLength(1)
  })

  it('surfaces an EF block (drift / requires payment) as an error and does not refund', async () => {
    efResponse = { ok: false, status: 409, payload: { error: 'Increasing the quantity adds a paid extra. Cancel and rebook to add paid services.', code: 'requires_payment' } }
    const res = await updateBookingQuantities(B1, [{ service_id: SVC_GENERAL, no_services: 5 }], EXPECTED)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Cancel and rebook to add paid services/)
    expect(refundInserts).toHaveLength(0)
  })
})

describe('updateBookingQuantities — booking_updated notification payload per refund state', () => {
  const notify = () => fetchCalls.find((c) => c.url.includes('/send-notification'))!

  it("initiated → refund_status 'processed' + refund_request_id, NEVER a caller-supplied refund_cents", async () => {
    // Default beforeEach state: refund_owed_cents=5000, insert ok, process-refund ok.
    await updateBookingQuantities(B1, REDUCE, EXPECTED)
    const body = notify().body
    expect(body.type).toBe('booking_updated')
    expect(body.refund_status).toBe('processed')
    expect(body.refund_request_id).toBe('refund-1')
    // The amount is derived server-side by send-notification from the
    // refund_request row (money-integrity hardening) — the payload must never
    // carry a forgeable cents figure.
    expect('refund_cents' in body).toBe(false)
    expect(typeof body.edit_ref).toBe('string')
    expect((body.edit_ref as string).length).toBeGreaterThan(0)
  })

  it("queued → refund_status 'pending_review' + refund_request_id (Pending row awaits approval)", async () => {
    processRefundOk = false
    await updateBookingQuantities(B1, REDUCE, EXPECTED)
    const body = notify().body
    expect(body.type).toBe('booking_updated')
    expect(body.refund_status).toBe('pending_review')
    expect(body.refund_request_id).toBe('refund-1')
    expect('refund_cents' in body).toBe(false)
    expect((body.edit_ref as string).length).toBeGreaterThan(0)
  })

  it('failed → no refund fields (no Pending row exists, so nothing to show)', async () => {
    refundInsertError = { message: 'RLS denied' }
    await updateBookingQuantities(B1, REDUCE, EXPECTED)
    const body = notify().body
    expect(body.type).toBe('booking_updated')
    expect('refund_status' in body).toBe(false)
    expect('refund_request_id' in body).toBe(false)
    expect('refund_cents' in body).toBe(false)
    // The resident is still notified their booking changed — just without a
    // refund line — so edit_ref must be present to key idempotency.
    expect((body.edit_ref as string).length).toBeGreaterThan(0)
  })

  it('none → no refund fields (free-quota change, nothing owed)', async () => {
    efResponse.payload.refund_owed_cents = 0
    await updateBookingQuantities(B1, [{ service_id: SVC_GENERAL, no_services: 2 }], EXPECTED)
    const body = notify().body
    expect(body.type).toBe('booking_updated')
    expect('refund_status' in body).toBe(false)
    expect('refund_request_id' in body).toBe(false)
    expect('refund_cents' in body).toBe(false)
    expect((body.edit_ref as string).length).toBeGreaterThan(0)
  })
})

describe('updateBookingQuantities — gating (server re-enforces the UI gate)', () => {
  it('rejects a MUD booking before calling the EF', async () => {
    booking!.type = 'MUD'
    const res = await updateBookingQuantities(B1, REDUCE, EXPECTED)
    expect(res.ok).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it('rejects a non-Confirmed booking (Pending Payment) before calling the EF', async () => {
    booking!.status = 'Pending Payment'
    const res = await updateBookingQuantities(B1, REDUCE, EXPECTED)
    expect(res.ok).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it('rejects a non-admin role', async () => {
    role = 'ranger'
    const res = await updateBookingQuantities(B1, REDUCE, EXPECTED)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/permission/i)
  })

  it('rejects an empty item set (removal = cancel & rebook)', async () => {
    const res = await updateBookingQuantities(B1, [{ service_id: SVC_GENERAL, no_services: 0 }], EXPECTED)
    expect(res.ok).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  // Confirmed-only: canEditCollectionDetails is wider (Scheduled/Completed for
  // contractor tier, the #378 date-correction path) and must NOT open the
  // quantity path — a post-dispatch reduction would refund a dispatched or
  // already-collected service and desync collection_stop rows.
  it.each(['Scheduled', 'Completed'] as const)(
    'rejects a %s booking even for contractor-admin (post-dispatch = cancel & rebook)',
    async (status) => {
      booking!.status = status
      const res = await updateBookingQuantities(B1, REDUCE, EXPECTED)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(new RegExp(status))
      expect(fetchCalls).toHaveLength(0)
      expect(refundInserts).toHaveLength(0)
    },
  )

  it('rejects a non-UUID booking id before any read', async () => {
    const res = await updateBookingQuantities('b1', REDUCE, EXPECTED)
    expect(res.ok).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it('rejects a booking with no location instead of fabricating one', async () => {
    booking!.location = null
    const res = await updateBookingQuantities(B1, REDUCE, EXPECTED)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/location/i)
    expect(fetchCalls).toHaveLength(0)
  })

  it('fails loud when the allocation_swap read errors (silently omitting swap would delete it)', async () => {
    swapError = { message: 'transient' }
    const res = await updateBookingQuantities(B1, REDUCE, EXPECTED)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/allocation swap/i)
    expect(fetchCalls).toHaveLength(0)
  })
})
