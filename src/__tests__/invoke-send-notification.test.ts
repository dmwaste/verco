/**
 * invokeSendNotification — the EF→EF hop from create-booking (free path) and
 * checkout-reconcile (paid path) to send-notification.
 *
 * Two live bookings (MOS-JOZCOM 13/10, KWN-2-I2NA9E 01/10) never got their
 * booking_created email: the one-shot fetch to send-notification got a gateway
 * 502/503 that never reached a worker, the caller logged to the console and
 * returned 200, and because the dispatcher never ran there was no
 * notification_log row and no Sentry event. This helper retries transient
 * gateway failures and, when it still can't get through, leaves a `failed`
 * row + a Sentry warning so the miss is visible and retryable from admin.
 *
 * Deno-only module loaded through a runtime-only import path (tsc never
 * follows it). fetch, sleep, the Supabase client and the Sentry reporter are
 * all injected.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

type Payload = { type: 'booking_created'; booking_id: string }
type Outcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; status: number | null; error: string }
type Deps = {
  supabase: unknown
  captureWarning: (message: string, extra?: Record<string, unknown>) => void
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  supabaseUrl: string
  serviceRoleKey: string
}
type Invoke = (payload: Payload, deps: Deps) => Promise<Outcome>

const MODULE = '../../supabase/functions/_shared/invoke-send-notification.ts'

let invokeSendNotification: Invoke
let RETRY_DELAYS_MS: readonly number[]
let MAX_RATE_LIMIT_WAIT_MS: number

beforeAll(async () => {
  ;({ invokeSendNotification, RETRY_DELAYS_MS, MAX_RATE_LIMIT_WAIT_MS } = (await import(
    /* @vite-ignore */ MODULE
  )) as {
    invokeSendNotification: Invoke
    RETRY_DELAYS_MS: readonly number[]
    MAX_RATE_LIMIT_WAIT_MS: number
  })
})

const BOOKING_ID = '489a4267-0000-4000-8000-000000000001'
const CLIENT_ID = 'c1000000-0000-4000-8000-000000000001'
const CONTACT_ID = 'd2000000-0000-4000-8000-000000000001'
const EMAIL = 'resident@example.com'

interface FakeDb {
  client: unknown
  inserted: Array<Record<string, unknown>>
  bookingReads: number
}

const MOBILE = '+61400000001'
const MG_SID = 'MG00000000000000000000000000000001'

/** Minimal fake of the query shapes the helper issues on final failure. */
function fakeDb(
  opts: {
    bookingError?: string
    /** Contact mobile + tenant Messaging Service → the booking would also text. */
    sms?: boolean
    /** Channels that already have a booking_created row (the dispatcher ran). */
    existingChannels?: string[]
  } = {},
): FakeDb {
  const db: FakeDb = { client: null, inserted: [], bookingReads: 0 }
  db.client = {
    from: (table: string) => {
      if (table === 'booking') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => {
            db.bookingReads += 1
            if (opts.bookingError) return { data: null, error: { message: opts.bookingError } }
            return {
              data: {
                client_id: CLIENT_ID,
                contact_id: CONTACT_ID,
                contact: { email: EMAIL, mobile_e164: opts.sms ? MOBILE : null },
                client: { twilio_messaging_service_sid: opts.sms ? MG_SID : null },
              },
              error: null,
            }
          },
        }
        return chain
      }
      if (table === 'notification_log') {
        const existing = (opts.existingChannels ?? []).map((channel) => ({ channel }))
        const chain = {
          select: () => chain,
          eq: () => chain,
          then: (resolve: (v: unknown) => void) => resolve({ data: existing, error: null }),
          insert: async (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
            db.inserted.push(...(Array.isArray(rows) ? rows : [rows]))
            return { error: null }
          },
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db
}

type Step = number | Error | { status: number; headers: Record<string, string> }

/** fetch stub that walks a scripted list of responses (number = HTTP status, Error = throw). */
function scriptedFetch(script: Step[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const step = script[calls.length - 1]
    if (step === undefined) throw new Error('fetch called more times than scripted')
    if (step instanceof Error) throw step
    const { status, headers } = typeof step === 'number' ? { status: step, headers: {} } : step
    return new Response(status >= 200 && status < 300 ? '{"ok":true}' : 'gateway error', { status, headers })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** The edge runtime's EF→EF throttle error (duck-typed on name, CLAUDE.md §11). */
function rateLimitError(retryAfterMs: number): Error {
  const err = new Error(`Rate limit exceeded. Retry after ${retryAfterMs}ms`) as Error & { retryAfterMs: number }
  err.name = 'RateLimitError'
  err.retryAfterMs = retryAfterMs
  return err
}

function makeDeps(db: FakeDb, fetchImpl: typeof fetch) {
  const sleeps: number[] = []
  const captureWarning = vi.fn()
  const deps: Deps = {
    supabase: db.client,
    captureWarning,
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
  }
  return { deps, sleeps, captureWarning }
}

describe('invokeSendNotification — transient gateway failure', () => {
  it('retries a 502 with backoff and succeeds without writing a failed row', async () => {
    const db = fakeDb()
    const { fetchImpl, calls } = scriptedFetch([502, 200])
    const { deps, sleeps, captureWarning } = makeDeps(db, fetchImpl)

    const outcome = await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(outcome).toEqual({ ok: true, attempts: 2 })
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([RETRY_DELAYS_MS[0]])
    expect(db.inserted).toHaveLength(0)
    expect(captureWarning).not.toHaveBeenCalled()
  })

  it('posts the payload to send-notification with the service-role bearer', async () => {
    const db = fakeDb()
    const { fetchImpl, calls } = scriptedFetch([200])
    const { deps } = makeDeps(db, fetchImpl)

    await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(calls[0]?.url).toBe('https://project.supabase.co/functions/v1/send-notification')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer service-role-test-key')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ type: 'booking_created', booking_id: BOOKING_ID })
  })

  it('backs off 500ms then 1500ms across the two retries', () => {
    expect(RETRY_DELAYS_MS).toEqual([500, 1500])
  })

  it('503 three times → exactly one failed notification_log row and one PII-free Sentry warning', async () => {
    const db = fakeDb()
    const { fetchImpl, calls } = scriptedFetch([503, 503, 503])
    const { deps, sleeps, captureWarning } = makeDeps(db, fetchImpl)

    const outcome = await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(outcome).toMatchObject({ ok: false, attempts: 3, status: 503 })
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([...RETRY_DELAYS_MS])

    expect(db.inserted).toHaveLength(1)
    const row = db.inserted[0]!
    expect(row).toMatchObject({
      booking_id: BOOKING_ID,
      client_id: CLIENT_ID,
      contact_id: CONTACT_ID,
      to_address: EMAIL,
      channel: 'email',
      notification_type: 'booking_created',
      status: 'failed',
    })
    expect(String(row.error_message)).toContain('503')

    expect(captureWarning).toHaveBeenCalledTimes(1)
    const [message, extra] = captureWarning.mock.calls[0]!
    expect(message).toBe('booking_created invoke failed')
    expect(extra).toMatchObject({ booking_id: BOOKING_ID, http_status: 503 })
    const serialised = JSON.stringify(extra)
    expect(serialised).not.toContain(EMAIL)
    expect(serialised).not.toMatch(/\+?61\d{9}|04\d{8}/)
  })

  it('treats a thrown network error like a 5xx: retries, then records the failure', async () => {
    const db = fakeDb()
    const { fetchImpl, calls } = scriptedFetch([
      new Error('connection reset'),
      new Error('connection reset'),
      new Error('connection reset'),
    ])
    const { deps, captureWarning } = makeDeps(db, fetchImpl)

    const outcome = await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(outcome).toMatchObject({ ok: false, attempts: 3, status: null })
    expect(calls).toHaveLength(3)
    expect(db.inserted).toHaveLength(1)
    expect(String(db.inserted[0]!.error_message)).toContain('connection reset')
    expect(captureWarning).toHaveBeenCalledTimes(1)
    expect(captureWarning.mock.calls[0]![1]).toMatchObject({ booking_id: BOOKING_ID, http_status: null })
  })

  it('retries 429 and 504 as well', async () => {
    const db = fakeDb()
    const { fetchImpl, calls } = scriptedFetch([429, 504, 200])
    const { deps } = makeDeps(db, fetchImpl)

    const outcome = await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(outcome).toEqual({ ok: true, attempts: 3 })
    expect(calls).toHaveLength(3)
  })
})

describe('invokeSendNotification — non-transient failure', () => {
  it('does not retry a 401 but still records the failure', async () => {
    const db = fakeDb()
    const { fetchImpl, calls } = scriptedFetch([401])
    const { deps, sleeps, captureWarning } = makeDeps(db, fetchImpl)

    const outcome = await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(outcome).toMatchObject({ ok: false, attempts: 1, status: 401 })
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(db.inserted).toHaveLength(1)
    expect(captureWarning).toHaveBeenCalledTimes(1)
  })

  it('never throws: a failed booking read still produces the Sentry warning', async () => {
    const db = fakeDb({ bookingError: 'permission denied' })
    const { fetchImpl } = scriptedFetch([503, 503, 503])
    const { deps, captureWarning } = makeDeps(db, fetchImpl)

    const outcome = await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(outcome.ok).toBe(false)
    expect(db.inserted).toHaveLength(0)
    expect(captureWarning).toHaveBeenCalledTimes(1)
  })
})

describe('invokeSendNotification — record every channel the booking would use (#671)', () => {
  it('writes a failed SMS row too when the contact can be texted', async () => {
    const db = fakeDb({ sms: true })
    const { fetchImpl } = scriptedFetch([503, 503, 503])
    const { deps, captureWarning } = makeDeps(db, fetchImpl)

    await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(db.inserted.map((r) => r.channel)).toEqual(['email', 'sms'])
    expect(db.inserted[1]).toMatchObject({
      channel: 'sms',
      to_address: MOBILE,
      status: 'failed',
      notification_type: 'booking_created',
      booking_id: BOOKING_ID,
    })
    const extra = captureWarning.mock.calls[0]![1] as Record<string, unknown>
    expect(extra).toMatchObject({ failed_channels: ['email', 'sms'] })
    expect(JSON.stringify(extra)).not.toContain(MOBILE)
  })

  it('does not write an SMS row when the tenant has no Messaging Service', async () => {
    const db = fakeDb()
    const { fetchImpl } = scriptedFetch([503, 503, 503])
    const { deps } = makeDeps(db, fetchImpl)

    await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(db.inserted.map((r) => r.channel)).toEqual(['email'])
  })

  it('leaves a channel alone when the dispatcher already logged it (a 504 after it started)', async () => {
    const db = fakeDb({ sms: true, existingChannels: ['email'] })
    const { fetchImpl } = scriptedFetch([504, 504, 504])
    const { deps } = makeDeps(db, fetchImpl)

    await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(db.inserted.map((r) => r.channel)).toEqual(['sms'])
  })

  it('writes nothing when both channels already have a row, but still warns Sentry', async () => {
    const db = fakeDb({ sms: true, existingChannels: ['email', 'sms'] })
    const { fetchImpl } = scriptedFetch([504, 504, 504])
    const { deps, captureWarning } = makeDeps(db, fetchImpl)

    await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(db.inserted).toHaveLength(0)
    expect(captureWarning).toHaveBeenCalledTimes(1)
  })
})

describe('invokeSendNotification — honour the throttle (#671, CLAUDE.md §11)', () => {
  it('waits the Retry-After a 429 asks for instead of the fixed backoff', async () => {
    const db = fakeDb()
    const { fetchImpl } = scriptedFetch([{ status: 429, headers: { 'retry-after': '2' } }, 200])
    const { deps, sleeps } = makeDeps(db, fetchImpl)

    const outcome = await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(outcome).toEqual({ ok: true, attempts: 2 })
    expect(sleeps).toEqual([2000])
  })

  it('waits a RateLimitError\'s retryAfterMs', async () => {
    const db = fakeDb()
    const { fetchImpl } = scriptedFetch([rateLimitError(3000), 200])
    const { deps, sleeps } = makeDeps(db, fetchImpl)

    const outcome = await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(outcome).toEqual({ ok: true, attempts: 2 })
    expect(sleeps).toEqual([3000])
  })

  it('never waits less than the normal backoff', async () => {
    const db = fakeDb()
    const { fetchImpl } = scriptedFetch([rateLimitError(10), 200])
    const { deps, sleeps } = makeDeps(db, fetchImpl)

    await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(sleeps).toEqual([RETRY_DELAYS_MS[0]])
  })

  it('records the failure at once when the throttle outlasts the wait budget (never holds the booking)', async () => {
    const db = fakeDb()
    const { fetchImpl, calls } = scriptedFetch([rateLimitError(MAX_RATE_LIMIT_WAIT_MS + 1)])
    const { deps, sleeps, captureWarning } = makeDeps(db, fetchImpl)

    const outcome = await invokeSendNotification({ type: 'booking_created', booking_id: BOOKING_ID }, deps)

    expect(outcome).toMatchObject({ ok: false, attempts: 1, status: null })
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(db.inserted).toHaveLength(1)
    expect(String(db.inserted[0]!.error_message)).toMatch(/rate limit/i)
    expect(captureWarning).toHaveBeenCalledTimes(1)
  })
})
