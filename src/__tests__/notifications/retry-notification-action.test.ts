/**
 * Admin Retry on /admin/notifications (#671).
 *
 * The send-claim index allows one queued-or-sent row per notification +
 * channel, so `retry_notification_log` (failed → queued) is refused with 23505
 * when another attempt already went out — e.g. the invoker recorded a `failed`
 * row after a 504 but the dispatcher had in fact sent. That refusal is the
 * double-send guard working; staff see why instead of a raw constraint error,
 * and nothing is dispatched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rpcError: null as null | { code: string; message: string },
  invoked: [] as unknown[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async (name: string) =>
      name === 'current_user_role'
        ? { data: 'contractor-admin', error: null }
        : { data: null, error: h.rpcError },
  }),
}))

vi.mock('@/lib/notifications/invoke', () => ({
  invokeSendNotification: async (_s: unknown, input: unknown) => {
    h.invoked.push(input)
  },
}))

import { retryNotification } from '@/app/(admin)/admin/notifications/actions'

beforeEach(() => {
  h.rpcError = null
  h.invoked = []
})

describe('retryNotification', () => {
  it('re-queues and dispatches a failed row', async () => {
    expect(await retryNotification('log-1')).toEqual({ ok: true, data: undefined })
    expect(h.invoked).toEqual([{ notification_log_id: 'log-1' }])
  })

  it('explains, and sends nothing, when the notification already went out', async () => {
    h.rpcError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "notification_log_send_claim_key"',
    }

    const result = await retryNotification('log-1')

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/already gone out/)
    expect(!result.ok && result.error).not.toMatch(/duplicate key/)
    expect(h.invoked).toEqual([])
  })
})
