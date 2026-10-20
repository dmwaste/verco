/**
 * invokeNotifyTicketResponse — the admin ticket page → notify-ticket-response
 * hop that emails the resident a staff reply (#671 follow-up).
 *
 * It was a one-shot fetch called with a bare `void` from the browser: a
 * gateway 502/503 dropped the resident's reply email with nothing but a
 * browser console line, and an EF-side failure (SendGrid error, no email on
 * file) was invisible to the staff member who just replied. Now it retries the
 * transient failures (safe: notify-ticket-response claims the send before
 * making it), reports what happened so the page can say so, and sends a
 * PII-free Sentry warning when the email didn't go out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeNotifyTicketResponse } from '@/lib/notifications/invoke-ticket-response'
import { RETRY_DELAYS_MS } from '@/lib/notifications/post-retry'

const RESPONSE_ID = '9c000000-0000-4000-8000-000000000001'

type Step = number | { status: number; json: Record<string, unknown> }

function fakeBrowserClient(session = true) {
  return {
    auth: {
      getSession: async () => ({ data: { session: session ? { access_token: 'staff-user-jwt' } : null } }),
    },
  }
}

function scriptedFetch(script: Step[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const step = script[calls.length - 1]
    if (step === undefined) throw new Error('fetch called more times than scripted')
    const { status, json } = typeof step === 'number' ? { status: step, json: { status: 'sent' } } : step
    return new Response(status < 300 ? JSON.stringify(json) : 'gateway error', { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function deps(fetchImpl: typeof fetch) {
  const sleeps: number[] = []
  const captureWarning = vi.fn()
  return {
    sleeps,
    captureWarning,
    opts: {
      fetch: fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      captureWarning,
    },
  }
}

type BrowserClient = Parameters<typeof invokeNotifyTicketResponse>[0]
const client = (session = true) => fakeBrowserClient(session) as unknown as BrowserClient

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

describe('invokeNotifyTicketResponse', () => {
  it('retries a gateway 502 and reports the email as sent', async () => {
    const { fetchImpl, calls } = scriptedFetch([502, 200])
    const { opts, sleeps, captureWarning } = deps(fetchImpl)

    const outcome = await invokeNotifyTicketResponse(client(), RESPONSE_ID, opts)

    expect(outcome).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([RETRY_DELAYS_MS[0]])
    expect(calls[0]?.url).toBe('https://project.supabase.co/functions/v1/notify-ticket-response')
    expect(calls[0]?.init?.method).toBe('POST')
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer staff-user-jwt')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ ticket_response_id: RESPONSE_ID })
    expect(captureWarning).not.toHaveBeenCalled()
  })

  it('reports not_sent and warns Sentry (ids only) when the gateway never gets through', async () => {
    const { fetchImpl, calls } = scriptedFetch([503, 503, 503])
    const { opts, captureWarning } = deps(fetchImpl)

    const outcome = await invokeNotifyTicketResponse(client(), RESPONSE_ID, opts)

    expect(outcome).toEqual({ ok: false, reason: 'not_sent' })
    expect(calls).toHaveLength(3)
    expect(captureWarning).toHaveBeenCalledTimes(1)
    expect(captureWarning.mock.calls[0]![1]).toMatchObject({ ticket_response_id: RESPONSE_ID, http_status: 503 })
  })

  it('reports not_sent when the EF itself could not send (SendGrid error)', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 200, json: { status: 'failed', error: 'SendGrid 500' } }])
    const { opts, captureWarning } = deps(fetchImpl)

    const outcome = await invokeNotifyTicketResponse(client(), RESPONSE_ID, opts)

    expect(outcome).toEqual({ ok: false, reason: 'not_sent' })
    expect(calls).toHaveLength(1)
    expect(captureWarning).toHaveBeenCalledTimes(1)
  })

  it('reports no_email (not a fault to retry) when the resident has no email address', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 200, json: { status: 'no_email' } }])
    const { opts, captureWarning } = deps(fetchImpl)

    expect(await invokeNotifyTicketResponse(client(), RESPONSE_ID, opts)).toEqual({ ok: false, reason: 'no_email' })
    expect(captureWarning).not.toHaveBeenCalled()
  })

  it('treats an already-sent or in-flight reply as sent (a resend never doubles up)', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 200, json: { status: 'skipped', reason: 'already_sent' } },
      { status: 200, json: { status: 'skipped', reason: 'in_flight' } },
    ])
    const { opts } = deps(fetchImpl)

    expect(await invokeNotifyTicketResponse(client(), RESPONSE_ID, opts)).toEqual({ ok: true })
    expect(await invokeNotifyTicketResponse(client(), RESPONSE_ID, opts)).toEqual({ ok: true })
  })

  it('does not retry a 403 (tenant mismatch) but still reports it', async () => {
    const { fetchImpl, calls } = scriptedFetch([403])
    const { opts, captureWarning } = deps(fetchImpl)

    expect(await invokeNotifyTicketResponse(client(), RESPONSE_ID, opts)).toEqual({ ok: false, reason: 'not_sent' })
    expect(calls).toHaveLength(1)
    expect(captureWarning).toHaveBeenCalledTimes(1)
  })

  it('never throws when fetch rejects: retries, then reports not_sent', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    const { opts, captureWarning } = deps(fetchImpl)

    await expect(invokeNotifyTicketResponse(client(), RESPONSE_ID, opts)).resolves.toEqual({
      ok: false,
      reason: 'not_sent',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1)
    expect(captureWarning.mock.calls[0]![1]).toMatchObject({ ticket_response_id: RESPONSE_ID, http_status: null })
  })

  it('with no session it reports not_sent without calling the EF', async () => {
    const { fetchImpl, calls } = scriptedFetch([])
    const { opts } = deps(fetchImpl)

    expect(await invokeNotifyTicketResponse(client(false), RESPONSE_ID, opts)).toEqual({ ok: false, reason: 'not_sent' })
    expect(calls).toHaveLength(0)
  })
})
