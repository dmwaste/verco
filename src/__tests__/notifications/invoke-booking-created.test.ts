/**
 * invokeBookingCreated — the server-action → send-notification hop for
 * bookings staff create in admin (the MUD booking path, #671).
 *
 * `createMudBooking` used to call the one-shot `invokeSendNotification` with a
 * bare `void`: a gateway 502/503 dropped the strata contact's confirmation with
 * no notification_log row and no Sentry event — the exact failure the EF-side
 * helper fixed for residents on 18/10 (#664). This helper gives the admin path
 * the same contract: awaited, retried, and on final failure a `failed` row per
 * channel (written under the staff member's own RLS) plus a PII-free warning.
 * It never throws — the booking is already committed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { invokeBookingCreated } from '@/lib/notifications/invoke'
import { RETRY_DELAYS_MS } from '@/lib/notifications/notify-retry'

const BOOKING_ID = '7b000000-0000-4000-8000-000000000001'
const CLIENT_ID = 'c1000000-0000-4000-8000-000000000002'
const CONTACT_ID = 'd2000000-0000-4000-8000-000000000002'
const EMAIL = 'strata@example.test'
const MOBILE = '+61400000002'

function fakeUserClient(opts: { session?: boolean; sms?: boolean; insertError?: string } = {}) {
  const inserted: Array<Record<string, unknown>> = []
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: opts.session === false ? null : { access_token: 'staff-user-jwt' } },
      }),
    },
    from: (table: string) => {
      if (table === 'booking') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({
            data: {
              client_id: CLIENT_ID,
              contact_id: CONTACT_ID,
              contact: { email: EMAIL, mobile_e164: opts.sms ? MOBILE : null },
              client: { twilio_messaging_service_sid: opts.sms ? 'MG00000000000000000000000000000002' : null },
            },
            error: null,
          }),
        }
        return chain
      }
      if (table === 'notification_log') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
          insert: async (rows: Array<Record<string, unknown>>) => {
            if (opts.insertError) return { error: { message: opts.insertError } }
            inserted.push(...rows)
            return { error: null }
          },
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { client, inserted }
}

function scriptedFetch(script: number[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const status = script[calls.length - 1]
    if (status === undefined) throw new Error('fetch called more times than scripted')
    return new Response(status < 300 ? '{"ok":true}' : 'gateway error', { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function opts(fetchImpl: typeof fetch) {
  const sleeps: number[] = []
  const captureWarning = vi.fn()
  return {
    sleeps,
    captureWarning,
    deps: {
      fetch: fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      captureWarning,
    },
  }
}

const ORIGINAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_URL
  vi.restoreAllMocks()
})

// The fake is shaped like the server client only as far as the helper uses it.
type ServerClient = Parameters<typeof invokeBookingCreated>[0]

describe('invokeBookingCreated', () => {
  it("retries a 503 and posts with the staff member's own session token (never the service role)", async () => {
    const { client, inserted } = fakeUserClient()
    const { fetchImpl, calls } = scriptedFetch([503, 200])
    const { deps, sleeps, captureWarning } = opts(fetchImpl)

    const outcome = await invokeBookingCreated(client as unknown as ServerClient, BOOKING_ID, deps)

    expect(outcome).toEqual({ ok: true, attempts: 2 })
    expect(sleeps).toEqual([RETRY_DELAYS_MS[0]])
    expect(calls[0]?.url).toBe('https://project.supabase.co/functions/v1/send-notification')
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer staff-user-jwt')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ type: 'booking_created', booking_id: BOOKING_ID })
    expect(inserted).toHaveLength(0)
    expect(captureWarning).not.toHaveBeenCalled()
  })

  it('on final failure writes a failed row per channel and a PII-free warning', async () => {
    const { client, inserted } = fakeUserClient({ sms: true })
    const { fetchImpl, calls } = scriptedFetch([503, 503, 503])
    const { deps, captureWarning } = opts(fetchImpl)

    const outcome = await invokeBookingCreated(client as unknown as ServerClient, BOOKING_ID, deps)

    expect(outcome).toMatchObject({ ok: false, attempts: 3, status: 503 })
    expect(calls).toHaveLength(3)
    expect(inserted).toEqual([
      expect.objectContaining({ channel: 'email', to_address: EMAIL, status: 'failed', booking_id: BOOKING_ID }),
      expect.objectContaining({ channel: 'sms', to_address: MOBILE, status: 'failed', booking_id: BOOKING_ID }),
    ])
    expect(captureWarning).toHaveBeenCalledTimes(1)
    const serialised = JSON.stringify(captureWarning.mock.calls[0])
    expect(serialised).not.toContain(EMAIL)
    expect(serialised).not.toContain(MOBILE)
  })

  it('with no session it does not call the EF, and still records the miss', async () => {
    const { client, inserted } = fakeUserClient({ session: false })
    const { fetchImpl, calls } = scriptedFetch([])
    const { deps, captureWarning } = opts(fetchImpl)

    const outcome = await invokeBookingCreated(client as unknown as ServerClient, BOOKING_ID, deps)

    expect(outcome).toMatchObject({ ok: false, attempts: 0 })
    expect(calls).toHaveLength(0)
    expect(inserted).toHaveLength(1)
    expect(String(inserted[0]!.error_message)).toMatch(/session/)
    expect(captureWarning).toHaveBeenCalledTimes(1)
  })

  it('never throws when the failed row cannot be written', async () => {
    const { client } = fakeUserClient({ insertError: 'new row violates row-level security policy' })
    const { fetchImpl } = scriptedFetch([503, 503, 503])
    const { deps, captureWarning } = opts(fetchImpl)

    const outcome = await invokeBookingCreated(client as unknown as ServerClient, BOOKING_ID, deps)

    expect(outcome.ok).toBe(false)
    expect(captureWarning).toHaveBeenCalledTimes(1)
    expect(captureWarning.mock.calls[0]![1]).toMatchObject({ notification_log_written: false })
  })
})
