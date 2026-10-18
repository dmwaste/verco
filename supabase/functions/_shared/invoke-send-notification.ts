// EF-only shared module (NOT mirrored — consumers are all Deno EFs).
//
// The ONE way an Edge Function fires `booking_created` at send-notification.
// Used by create-booking (free path, booking lands Confirmed) and
// _shared/checkout-reconcile.ts (paid path, Pending Payment → Confirmed).
//
// Why this exists (18/10/2026): both callers carried a copy-pasted one-shot
// `fetch` called with a bare `void`. A gateway 502/503 that never reached a
// send-notification worker (about 1 in 1,000 calls) was console.error'd and
// dropped — the dispatcher never ran, so there was no notification_log row,
// and the caller returned 200, so Sentry saw nothing. Two live bookings
// (MOS-JOZCOM 13/10, KWN-2-I2NA9E 01/10) lost their confirmation that way.
//
// Contract:
//   - AWAITED by the caller (never bare `void`): the edge runtime may freeze a
//     dangling promise once the handler returns.
//   - Retries transient gateway failures (429/502/503/504 or a thrown fetch)
//     twice, backing off 500 ms then 1,500 ms. Safe: the dispatcher's
//     idempotency key skips when a `sent` row already exists per channel.
//   - On FINAL failure writes a `failed` notification_log row (status
//     'failed', error_message = 'invoke: HTTP 503' etc.) so the miss shows on
//     /admin/notifications and can be retried from there (the resume-by-log-id
//     path re-renders from the booking and only skips on `sent`), and reports a
//     PII-free Sentry warning (ids + HTTP status only).
//   - NEVER throws and never changes the booking: by the time we notify, the
//     booking is committed and must not be reverted.
//
// Dependencies are injected (Supabase client, Sentry reporter, fetch, sleep)
// so Vitest can load this Deno module through a runtime-only import without
// pulling `@sentry/deno` from esm.sh — `src/__tests__/invoke-send-notification.test.ts`.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from './database.types.ts'

export type BookingCreatedPayload = {
  type: 'booking_created'
  booking_id: string
}

export interface InvokeSendNotificationDeps {
  /** Service-role client — used only to record the failed row on final failure. */
  supabase: SupabaseClient<Database>
  /** `captureWarning` from `./sentry.ts` (injected so tests need no Sentry). */
  captureWarning: (message: string, extra?: Record<string, unknown>) => void
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Default `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the EF env. */
  supabaseUrl?: string
  serviceRoleKey?: string
}

export type InvokeSendNotificationOutcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; status: number | null; error: string }

/** Backoff before retry 1 and retry 2 (ms). Two retries → three attempts. */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1500]

/** Gateway / throttle statuses worth a retry. Anything else is final. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504])

/** Per-attempt cap so a hung gateway can't hold create-booking to the 150 s edge limit. */
const ATTEMPT_TIMEOUT_MS = 10_000

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function envOr(name: string, injected: string | undefined): string {
  if (injected !== undefined) return injected
  // `Deno` is absent under Vitest; tests always inject the URL + key.
  return typeof Deno !== 'undefined' ? (Deno.env.get(name) ?? '') : ''
}

type Attempt =
  | { kind: 'ok' }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'thrown'; error: string }

export async function invokeSendNotification(
  payload: BookingCreatedPayload,
  deps: InvokeSendNotificationDeps,
): Promise<InvokeSendNotificationOutcome> {
  const fetchImpl = deps.fetch ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const url = `${envOr('SUPABASE_URL', deps.supabaseUrl)}/functions/v1/send-notification`
  const serviceKey = envOr('SUPABASE_SERVICE_ROLE_KEY', deps.serviceRoleKey)

  const maxAttempts = RETRY_DELAYS_MS.length + 1
  let last: Attempt = { kind: 'thrown', error: 'not attempted' }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await attemptOnce(fetchImpl, url, serviceKey, payload)
    if (last.kind === 'ok') return { ok: true, attempts: attempt }

    const retryable = last.kind === 'thrown' || RETRYABLE_STATUSES.has(last.status)
    const delay = RETRY_DELAYS_MS[attempt - 1]
    if (!retryable || delay === undefined) {
      return await recordFinalFailure(payload, deps, attempt, last)
    }
    console.warn(
      `[notifications] send-notification ${describe(last)} for ${payload.type} ${payload.booking_id} — retry ${attempt}/${RETRY_DELAYS_MS.length} in ${delay}ms`,
    )
    await sleep(delay)
  }

  // Unreachable: the loop returns on success or on the last attempt.
  return await recordFinalFailure(payload, deps, maxAttempts, last)
}

async function attemptOnce(
  fetchImpl: typeof fetch,
  url: string,
  serviceKey: string,
  payload: BookingCreatedPayload,
): Promise<Attempt> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    })
    if (res.ok) return { kind: 'ok' }
    const body = await res.text().catch(() => '(no body)')
    return { kind: 'http', status: res.status, body: body.slice(0, 500) }
  } catch (err) {
    return { kind: 'thrown', error: err instanceof Error ? err.message : String(err) }
  }
}

function describe(a: Attempt): string {
  if (a.kind === 'http') return `returned HTTP ${a.status}`
  if (a.kind === 'thrown') return `threw (${a.error})`
  return 'succeeded'
}

/**
 * Final failure: leave a `failed` notification_log row + a Sentry warning.
 * Every step is guarded — this must never throw back into a money path.
 */
async function recordFinalFailure(
  payload: BookingCreatedPayload,
  deps: InvokeSendNotificationDeps,
  attempts: number,
  last: Attempt,
): Promise<InvokeSendNotificationOutcome> {
  const status = last.kind === 'http' ? last.status : null
  const error =
    last.kind === 'http' ? `invoke: HTTP ${last.status}` : `invoke: ${last.kind === 'thrown' ? last.error : 'unknown'}`

  console.error(
    `[notifications] send-notification ${describe(last)} for ${payload.type} ${payload.booking_id} after ${attempts} attempt(s)` +
      (last.kind === 'http' ? `: ${last.body}` : ''),
  )

  let logged = false
  try {
    const { data: booking, error: readErr } = await deps.supabase
      .from('booking')
      .select('client_id, contact_id, contact:contact_id ( email )')
      .eq('id', payload.booking_id)
      .maybeSingle()

    if (readErr || !booking) {
      console.error(
        `[notifications] could not load booking ${payload.booking_id} to record the failed send: ${readErr?.message ?? 'not found'}`,
      )
    } else {
      const contact = booking.contact as { email: string | null } | null
      const { error: insertErr } = await deps.supabase.from('notification_log').insert({
        booking_id: payload.booking_id,
        contact_id: booking.contact_id,
        client_id: booking.client_id,
        channel: 'email',
        notification_type: payload.type,
        to_address: contact?.email ?? 'unknown',
        status: 'failed',
        error_message: error,
      })
      if (insertErr) {
        console.error(`[notifications] failed to write notification_log row: ${insertErr.message}`)
      } else {
        logged = true
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
    notification_log_written: logged,
  })

  return { ok: false, attempts, status, error }
}
