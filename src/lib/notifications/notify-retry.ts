// Mirrored: supabase/functions/_shared/notify-retry.ts → src/lib/notifications/notify-retry.ts
// (scripts/sync-mirrors.sh — edit the _shared copy). Pure logic + injected I/O so
// both callers share ONE retry contract:
//   - Edge Functions (create-booking, checkout-reconcile) via
//     _shared/invoke-send-notification.ts, with the service-role bearer;
//   - server actions (admin MUD booking) via src/lib/notifications/invoke.ts,
//     with the staff member's own session token (CLAUDE.md §20 Red Line #3).
// Never name the service-role env var in this file: the mirror lands in src/,
// where deploy.yml's Red Line #3 grep fails the image build on the name alone.
//
// Contract (#664, extended by #671):
//   - Retries transient failures (429/502/503/504 or a thrown fetch) twice,
//     backing off 500 ms then 1,500 ms. Retrying a 504 or our own timeout is
//     safe because the dispatcher CLAIMS each channel before sending (a `queued`
//     row under notification_log_send_claim_key) — a retry that lands while the
//     first attempt is still sending is skipped, never sent twice.
//   - A 429 / RateLimitError waits the retry-after it was given (never less
//     than the backoff). One longer than MAX_RATE_LIMIT_WAIT_MS isn't waited
//     out — the caller is holding a booking response — it's recorded instead.
//   - On FINAL failure writes a `failed` row for each channel the booking would
//     use (email; SMS when the contact can be texted) that has no row yet, so
//     the miss shows on /admin/notifications and can be retried per channel,
//     and reports a PII-free Sentry warning (ids + HTTP status only).
//   - NEVER throws: the booking is committed before we notify.

import { isSmsDeliverable } from './dispatch'

export type BookingCreatedPayload = {
  type: 'booking_created'
  booking_id: string
}

export type InvokeOutcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; status: number | null; error: string }

/** Backoff before retry 1 and retry 2 (ms). Two retries → three attempts. */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1500]

/** Gateway / throttle statuses worth a retry. Anything else is final. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504])

/** Per-attempt cap so a hung gateway can't hold the caller to the 150 s edge limit. */
export const ATTEMPT_TIMEOUT_MS = 10_000

/** Longest throttle wait worth holding a booking response for. */
export const MAX_RATE_LIMIT_WAIT_MS = 5_000

/** Embedded PostgREST relation — object, single-element array, or null. */
type Embedded<T> = T | T[] | null

/** booking columns the failure rows need. */
export const FAILURE_TARGET_SELECT =
  'client_id, contact_id, contact:contact_id ( email, mobile_e164 ), client:client_id ( twilio_messaging_service_sid )'

/** Who the failed rows are addressed to, read from the booking at failure time. */
export interface FailureTarget {
  client_id: string
  contact_id: string | null
  email: string | null
  mobile_e164: string | null
  messaging_service_sid: string | null
}

export function toFailureTarget(row: {
  client_id: string
  contact_id: string | null
  contact: Embedded<{ email: string | null; mobile_e164: string | null }>
  client: Embedded<{ twilio_messaging_service_sid: string | null }>
}): FailureTarget {
  const one = <T>(v: Embedded<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)
  const contact = one(row.contact)
  return {
    client_id: row.client_id,
    contact_id: row.contact_id,
    email: contact?.email ?? null,
    mobile_e164: contact?.mobile_e164 ?? null,
    messaging_service_sid: one(row.client)?.twilio_messaging_service_sid ?? null,
  }
}

export interface FailedNotificationRow {
  booking_id: string
  contact_id: string | null
  client_id: string
  channel: 'email' | 'sms'
  notification_type: 'booking_created'
  to_address: string
  status: 'failed'
  error_message: string
}

/** The notification_log reads/writes a final failure needs, under the caller's client. */
export interface FailureLog {
  loadTarget: (bookingId: string) => Promise<FailureTarget | { error: string }>
  /** Channels that already have a booking_created row of ANY status — the dispatcher ran for those. */
  loggedChannels: (bookingId: string) => Promise<Set<string> | { error: string }>
  insertFailed: (rows: FailedNotificationRow[]) => Promise<{ error: string | null }>
}

export interface InvokeWithRetryDeps {
  /** Full send-notification URL. */
  url: string
  /** Bearer for send-notification; null = no credential, so nothing is attempted. */
  bearer: string | null
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  captureWarning: (message: string, extra?: Record<string, unknown>) => void
  failureLog: FailureLog
}

type Attempt =
  | { kind: 'ok' }
  | { kind: 'http'; status: number; body: string; retryAfterMs: number | null }
  | { kind: 'thrown'; error: string; retryAfterMs: number | null }

type FailedAttempt = Exclude<Attempt, { kind: 'ok' }>

/**
 * The edge runtime's EF→EF throttle (CLAUDE.md §11) throws a `RateLimitError`
 * with `retryAfterMs`. Duck-typed on `name`; same parse as
 * `rateLimitRetryAfterMs` in _shared/schedule-transition.ts (a separate mirror
 * tree, so not importable from here).
 */
function thrownRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof Error) || err.name !== 'RateLimitError') return null
  const declared = (err as Error & { retryAfterMs?: unknown }).retryAfterMs
  if (typeof declared === 'number' && declared > 0) return declared
  const parsed = /Retry after (\d+)\s*ms/i.exec(err.message)
  return parsed ? Number(parsed[1]) : 60_000
}

/** `Retry-After` in seconds (the HTTP-date form is treated as unknown). */
function headerRetryAfterMs(res: Response): number | null {
  const seconds = Number(res.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

async function attemptOnce(
  payload: BookingCreatedPayload,
  deps: InvokeWithRetryDeps,
  bearer: string,
): Promise<Attempt> {
  try {
    const res = await deps.fetch(deps.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    })
    if (res.ok) return { kind: 'ok' }
    const body = await res.text().catch(() => '(no body)')
    return {
      kind: 'http',
      status: res.status,
      body: body.slice(0, 500),
      retryAfterMs: res.status === 429 ? headerRetryAfterMs(res) : null,
    }
  } catch (err) {
    return {
      kind: 'thrown',
      error: err instanceof Error ? err.message : String(err),
      retryAfterMs: thrownRetryAfterMs(err),
    }
  }
}

function describe(a: FailedAttempt): string {
  return a.kind === 'http' ? `returned HTTP ${a.status}` : `threw (${a.error})`
}

export async function invokeBookingCreatedWithRetry(
  payload: BookingCreatedPayload,
  deps: InvokeWithRetryDeps,
): Promise<InvokeOutcome> {
  if (!deps.bearer) {
    return await recordFinalFailure(payload, deps, 0, {
      kind: 'thrown',
      error: 'no bearer token (no session or service key) — send-notification was not called',
      retryAfterMs: null,
    })
  }

  for (let attempt = 1; ; attempt++) {
    const last = await attemptOnce(payload, deps, deps.bearer)
    if (last.kind === 'ok') return { ok: true, attempts: attempt }

    const retryable = last.kind === 'thrown' || RETRYABLE_STATUSES.has(last.status)
    const backoff = RETRY_DELAYS_MS[attempt - 1]
    if (!retryable || backoff === undefined) {
      return await recordFinalFailure(payload, deps, attempt, last)
    }
    const wait = Math.max(backoff, last.retryAfterMs ?? 0)
    if (wait > MAX_RATE_LIMIT_WAIT_MS) {
      return await recordFinalFailure(payload, deps, attempt, last, wait)
    }
    console.warn(
      `[notifications] send-notification ${describe(last)} for ${payload.type} ${payload.booking_id} — retry ${attempt}/${RETRY_DELAYS_MS.length} in ${wait}ms`,
    )
    await deps.sleep(wait)
  }
}

/** One `failed` row per channel the booking would use that has no row yet. */
export function failedRowsFor(
  payload: BookingCreatedPayload,
  target: FailureTarget,
  logged: ReadonlySet<string>,
  error: string,
): FailedNotificationRow[] {
  const base = {
    booking_id: payload.booking_id,
    contact_id: target.contact_id,
    client_id: target.client_id,
    notification_type: payload.type,
    status: 'failed' as const,
    error_message: error,
  }
  const rows: FailedNotificationRow[] = []
  if (!logged.has('email')) rows.push({ ...base, channel: 'email', to_address: target.email || 'unknown' })
  if (!logged.has('sms') && isSmsDeliverable(target.mobile_e164) && target.messaging_service_sid) {
    rows.push({ ...base, channel: 'sms', to_address: target.mobile_e164 })
  }
  return rows
}

/**
 * Final failure: leave `failed` rows + a Sentry warning. Every step is
 * guarded — this must never throw back into a booking path.
 */
async function recordFinalFailure(
  payload: BookingCreatedPayload,
  deps: InvokeWithRetryDeps,
  attempts: number,
  last: FailedAttempt,
  throttledWaitMs?: number,
): Promise<InvokeOutcome> {
  const status = last.kind === 'http' ? last.status : null
  const error =
    (last.kind === 'http' ? `invoke: HTTP ${last.status}` : `invoke: ${last.error}`) +
    (throttledWaitMs !== undefined ? ` (rate limited — retry after ${throttledWaitMs} ms, not waited)` : '')

  console.error(
    `[notifications] send-notification ${describe(last)} for ${payload.type} ${payload.booking_id} after ${attempts} attempt(s)` +
      (last.kind === 'http' ? `: ${last.body}` : ''),
  )

  let written: Array<'email' | 'sms'> = []
  try {
    const target = await deps.failureLog.loadTarget(payload.booking_id)
    if ('error' in target) {
      console.error(
        `[notifications] could not load booking ${payload.booking_id} to record the failed send: ${target.error}`,
      )
    } else {
      // A failed lookup writes every channel — an extra failed row is
      // harmless (Retry is claim-guarded), a missing one hides the miss.
      const logged = await deps.failureLog.loggedChannels(payload.booking_id)
      const rows = failedRowsFor(payload, target, 'error' in logged ? new Set() : logged, error)
      if (rows.length > 0) {
        const { error: insertErr } = await deps.failureLog.insertFailed(rows)
        if (insertErr) console.error(`[notifications] failed to write notification_log rows: ${insertErr}`)
        else written = rows.map((r) => r.channel)
      }
    }
  } catch (err) {
    console.error(
      `[notifications] recording the failed send threw: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Ids + status only — never contact fields (Sentry is EU-hosted).
  deps.captureWarning('booking_created invoke failed', {
    booking_id: payload.booking_id,
    http_status: status,
    attempts,
    notification_log_written: written.length > 0,
    failed_channels: written,
  })

  return { ok: false, attempts, status, error }
}
