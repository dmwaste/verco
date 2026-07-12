import { describe, it, expect, vi, beforeEach } from 'vitest'
import { orchestrateRefund } from '@/lib/payments/orchestrate-refund'
import { REFUND_REASONS } from '@/lib/refunds/auto-raised'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

// Unit test for the shared refund-orchestration helper (#389.1) — the single
// path behind cancel / quantity-reduction / NCN / NP refunds. Exercises each of
// the four outcome states with the supabase client + fetch mocked.

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'

let insertError: { message: string } | null
let hasSession: boolean
let processRefundOk: boolean
let inserted: Array<Record<string, unknown>>
let fetchCalls: string[]

function makeClient(): SupabaseClient<Database> {
  return {
    from: (table: string) => {
      if (table !== 'refund_request') throw new Error(`unexpected table ${table}`)
      return {
        insert: (row: Record<string, unknown>) => {
          if (!insertError) inserted.push(row)
          return {
            select: () => ({
              single: () =>
                Promise.resolve(
                  insertError ? { data: null, error: insertError } : { data: { id: 'refund-1' }, error: null },
                ),
            }),
          }
        },
      }
    },
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: hasSession ? { access_token: 'tok' } : null } }),
    },
  } as unknown as SupabaseClient<Database>
}

const BOOKING = '9a1f6f2e-1c6b-4a1e-9f7d-2b8c3d4e5f60'
const CONTACT = '5e0c9b8a-7d6f-4c3b-a291-8f7e6d5c4b3a'
const CLIENT = '1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901'

beforeEach(() => {
  insertError = null
  hasSession = true
  processRefundOk = true
  inserted = []
  fetchCalls = []
  vi.stubGlobal('fetch', async (url: string) => {
    fetchCalls.push(url)
    return { ok: processRefundOk, status: processRefundOk ? 200 : 403, text: async () => '{}' }
  })
})

const input = { bookingId: BOOKING, contactId: CONTACT, clientId: CLIENT, amountCents: 5000, reason: REFUND_REASONS.staffCancellation }

describe('orchestrateRefund', () => {
  it("returns 'none' and does nothing when amount <= 0", async () => {
    const res = await orchestrateRefund(makeClient(), { ...input, amountCents: 0 })
    expect(res.state).toBe('none')
    expect(inserted).toHaveLength(0)
    expect(fetchCalls).toHaveLength(0)
  })

  it("returns 'none' when contact or client is missing (no row, no fetch)", async () => {
    expect((await orchestrateRefund(makeClient(), { ...input, contactId: null })).state).toBe('none')
    expect((await orchestrateRefund(makeClient(), { ...input, clientId: null })).state).toBe('none')
    expect(inserted).toHaveLength(0)
  })

  it("returns 'initiated' when the request is created and process-refund accepts", async () => {
    const res = await orchestrateRefund(makeClient(), input)
    expect(res.state).toBe('initiated')
    // The created row id is returned so callers can hand it to send-notification,
    // which derives the DISPLAYED refund amount from this row (never trusts a
    // caller-supplied cents figure).
    expect(res.refundRequestId).toBe('refund-1')
    expect(inserted[0]).toMatchObject({ booking_id: BOOKING, amount_cents: 5000, status: 'Pending', reason: REFUND_REASONS.staffCancellation })
    expect(fetchCalls.some((u) => u.includes('/process-refund'))).toBe(true)
  })

  it("returns 'queued' when process-refund declines (e.g. -staff role)", async () => {
    processRefundOk = false
    const res = await orchestrateRefund(makeClient(), input)
    expect(res.state).toBe('queued')
    // Pending row exists — recoverable from the Refunds page.
    expect(inserted).toHaveLength(1)
  })

  it("returns 'queued' when there is no session (Pending row still created)", async () => {
    hasSession = false
    const res = await orchestrateRefund(makeClient(), input)
    expect(res.state).toBe('queued')
    expect(inserted).toHaveLength(1)
    expect(fetchCalls.some((u) => u.includes('/process-refund'))).toBe(false)
  })

  it("returns 'queued' (never throws) when the process-refund fetch rejects at the network level", async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    const res = await orchestrateRefund(makeClient(), input)
    expect(res.state).toBe('queued')
    // Pending row exists — recoverable from the Refunds page.
    expect(inserted).toHaveLength(1)
  })

  it("returns 'failed' when the refund_request insert is rejected (no Pending row)", async () => {
    insertError = { message: 'RLS denied' }
    const res = await orchestrateRefund(makeClient(), input)
    expect(res.state).toBe('failed')
    // No row created → no id to hand downstream.
    expect(res.refundRequestId).toBeUndefined()
    expect(fetchCalls.some((u) => u.includes('/process-refund'))).toBe(false)
  })
})
