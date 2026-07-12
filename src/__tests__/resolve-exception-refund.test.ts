import { describe, it, expect, vi, beforeEach } from 'vitest'

// Integration tests for the NCN / NP contractor-fault "resolve with refund"
// server actions. A contractor-fault resolution refunds the paid extras via the
// shared orchestrator — the resident must be told WHY money landed on their
// card (booking_updated + refund line), and staff must see when the refund
// could NOT be recorded ('failed'). Mirrors update-booking-quantities.test.ts:
// real orchestration, supabase client + fetch mocked.

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ getAll: () => [] }),
}))

// Test-controlled state.
let role = 'contractor-admin'
let notice: Record<string, unknown> | null
let noticeUpdateError: { message: string } | null = null
let refundInsertError: { message: string } | null = null
let processRefundOk = true
const refundInserts: Array<Record<string, unknown>> = []

const NCN_ID = '11111111-1111-4111-8111-111111111111'
const NP_ID = '22222222-2222-4222-8222-222222222222'
const BOOKING = '9a1f6f2e-1c6b-4a1e-9f7d-2b8c3d4e5f60'

function makeNotice(): Record<string, unknown> {
  return {
    id: NCN_ID,
    status: 'Under Review',
    booking_id: BOOKING,
    booking: {
      id: BOOKING,
      contact_id: 'c1',
      client_id: 'client-1',
      booking_item: [
        { unit_price_cents: 2500, no_services: 2, is_extra: true }, // $50 paid
        { unit_price_cents: 0, no_services: 1, is_extra: false }, // free — ignored
      ],
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: (name: string) =>
      name === 'current_user_role'
        ? Promise.resolve({ data: role, error: null })
        : Promise.resolve({ data: null }),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } }, error: null }),
      getSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }),
    },
    from: (table: string) => {
      if (table === 'non_conformance_notice' || table === 'nothing_presented') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: notice, error: notice ? null : { message: 'not found' } }),
            }),
          }),
          update: () => ({ eq: () => Promise.resolve({ error: noticeUpdateError }) }),
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

import { resolveWithRefund } from '@/app/(admin)/admin/non-conformance/[id]/actions'
import { resolveNpWithRefund } from '@/app/(admin)/admin/nothing-presented/[id]/actions'

interface FetchCall {
  url: string
  body: Record<string, unknown>
}
let fetchCalls: FetchCall[] = []

beforeEach(() => {
  role = 'contractor-admin'
  notice = makeNotice()
  noticeUpdateError = null
  refundInsertError = null
  processRefundOk = true
  refundInserts.length = 0
  fetchCalls = []
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) })
    if (url.includes('/process-refund')) {
      return {
        ok: processRefundOk,
        status: processRefundOk ? 200 : 403,
        text: async () => (processRefundOk ? '{}' : '{"error":"Insufficient permissions"}'),
        json: async () => ({}),
      }
    }
    // send-notification
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
  })
})

// Both actions have identical refund/notification wiring — run the same battery
// against each so NCN and NP can never drift.
const cases = [
  { name: 'resolveWithRefund (NCN)', run: () => resolveWithRefund(NCN_ID, 'sorted'), noticeId: NCN_ID },
  { name: 'resolveNpWithRefund (NP)', run: () => resolveNpWithRefund(NP_ID, 'sorted'), noticeId: NP_ID },
] as const

describe.each(cases)('$name — contractor-fault refund → resident notification', ({ run, noticeId }) => {
  const notify = () => fetchCalls.find((c) => c.url.includes('/send-notification'))

  it('raises a Pending refund_request for the paid amount and fires process-refund', async () => {
    await run()
    expect(refundInserts).toHaveLength(1)
    expect(refundInserts[0]).toMatchObject({ booking_id: BOOKING, amount_cents: 5000, status: 'Pending' })
    const refundCall = fetchCalls.find((c) => c.url.includes('/process-refund'))!
    expect(refundCall.body.refund_request_id).toBe('refund-1')
  })

  it("initiated → booking_updated with refund_status 'processed' + refund_request_id, keyed by the notice id", async () => {
    await run()
    const body = notify()!.body
    expect(body.type).toBe('booking_updated')
    expect(body.booking_id).toBe(BOOKING)
    expect(body.refund_status).toBe('processed')
    expect(body.refund_request_id).toBe('refund-1')
    // Stable per-notice idempotency discriminator — never a caller-supplied amount.
    expect(body.edit_ref).toBe(noticeId)
    expect('refund_cents' in body).toBe(false)
  })

  it('surfaces the refund state to staff in the Result', async () => {
    const res = await run()
    expect(res).toEqual({ ok: true, data: { refundState: 'initiated', refundAmountCents: 5000 } })
  })

  it("queued (process-refund declines) → refund_status 'pending_review', refundState 'queued'", async () => {
    processRefundOk = false
    const res = await run()
    expect(notify()!.body.refund_status).toBe('pending_review')
    expect(res).toEqual({ ok: true, data: { refundState: 'queued', refundAmountCents: 5000 } })
    // Pending row exists — recoverable from the Refunds page.
    expect(refundInserts).toHaveLength(1)
  })

  it("failed (refund_request insert rejected) → NO resident notification, refundState 'failed'", async () => {
    refundInsertError = { message: 'RLS denied' }
    const res = await run()
    // No Pending row exists — never tell the resident a refund is coming.
    expect(notify()).toBeUndefined()
    expect(fetchCalls.some((c) => c.url.includes('/process-refund'))).toBe(false)
    expect(res).toEqual({ ok: true, data: { refundState: 'failed', refundAmountCents: 5000 } })
  })

  it('does not error when the notice was already resolved in another tab', async () => {
    notice!.status = 'Resolved'
    const res = await run()
    expect(res.ok).toBe(false)
    expect(refundInserts).toHaveLength(0)
    expect(notify()).toBeUndefined()
  })

  it('rejects a non-staff caller before any write', async () => {
    role = 'resident'
    const res = await run()
    expect(res.ok).toBe(false)
    expect(refundInserts).toHaveLength(0)
    expect(fetchCalls).toHaveLength(0)
  })
})
