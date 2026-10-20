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
// Contract (#664, extended by #671): the retry loop itself is ./post-retry.ts
// (retries 429/502/503/504 + thrown fetches, honours retry-after, claim-guarded
// so a 504 retry can't double-send). On top of it, this file:
//   - on FINAL failure writes a `failed` row for each channel the booking would
//     use (email; SMS when the contact can be texted) that has no row yet, so
//     the miss shows on /admin/notifications and can be retried per channel,
//     and reports a PII-free Sentry warning (ids + HTTP status only);
//   - NEVER throws: the booking is committed before we notify.

import { isSmsDeliverable } from './dispatch'
import { describeAttempt, postWithRetry, type FailedAttempt } from './post-retry'

export { ATTEMPT_TIMEOUT_MS, MAX_RATE_LIMIT_WAIT_MS, RETRY_DELAYS_MS, RETRYABLE_STATUSES } from './post-retry'

export type BookingCreatedPayload = {
  type: 'booking_created'
  booking_id: string
}

export type InvokeOutcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; status: number | null; error: string }

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

  const res = await postWithRetry(payload, {
    url: deps.url,
    bearer: deps.bearer,
    fetch: deps.fetch,
    sleep: deps.sleep,
    label: `send-notification ${payload.type} ${payload.booking_id}`,
  })
  if (res.ok) return { ok: true, attempts: res.attempts }
  return await recordFinalFailure(payload, deps, res.attempts, res.last, res.throttledWaitMs)
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
    `[notifications] send-notification ${describeAttempt(last)} for ${payload.type} ${payload.booking_id} after ${attempts} attempt(s)` +
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
