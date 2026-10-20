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
// Contract: see ./notify-retry.ts — retries (claim-guarded, so a 504 retry
// can't double-send, #671), honours retry-after, records a `failed` row per
// channel + a PII-free Sentry warning on final failure, never throws. This
// file only supplies the EF side: the service-role bearer from the EF env and
// the service-role client for the failure rows. The caller AWAITS it (never
// bare `void`): the edge runtime may freeze a dangling promise once the
// handler returns.
//
// Dependencies are injected (Supabase client, Sentry reporter, fetch, sleep)
// so Vitest can load this Deno module through a runtime-only import without
// pulling `@sentry/deno` from esm.sh — `src/__tests__/invoke-send-notification.test.ts`.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from './database.types.ts'
import {
  FAILURE_TARGET_SELECT,
  invokeBookingCreatedWithRetry,
  toFailureTarget,
  type BookingCreatedPayload,
  type FailureLog,
  type InvokeOutcome,
} from './notify-retry.ts'

export { MAX_RATE_LIMIT_WAIT_MS, RETRY_DELAYS_MS, RETRYABLE_STATUSES } from './notify-retry.ts'
export type { BookingCreatedPayload } from './notify-retry.ts'
export type InvokeSendNotificationOutcome = InvokeOutcome

export interface InvokeSendNotificationDeps {
  /** Service-role client — used only to record the failed rows on final failure. */
  supabase: SupabaseClient<Database>
  /** `captureWarning` from `./sentry.ts` (injected so tests need no Sentry). */
  captureWarning: (message: string, extra?: Record<string, unknown>) => void
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Default `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the EF env. */
  supabaseUrl?: string
  serviceRoleKey?: string
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function envOr(name: string, injected: string | undefined): string {
  if (injected !== undefined) return injected
  // `Deno` is absent under Vitest; tests always inject the URL + key.
  return typeof Deno !== 'undefined' ? (Deno.env.get(name) ?? '') : ''
}

/** notification_log access for the failure rows, under the service-role client. */
function failureLog(supabase: SupabaseClient<Database>): FailureLog {
  return {
    loadTarget: async (bookingId) => {
      const { data, error } = await supabase
        .from('booking')
        .select(FAILURE_TARGET_SELECT)
        .eq('id', bookingId)
        .maybeSingle()
      if (error || !data) return { error: error?.message ?? 'not found' }
      return toFailureTarget(data)
    },
    loggedChannels: async (bookingId) => {
      const { data, error } = await supabase
        .from('notification_log')
        .select('channel')
        .eq('booking_id', bookingId)
        .eq('notification_type', 'booking_created')
      if (error) return { error: error.message }
      return new Set((data ?? []).map((r) => r.channel))
    },
    insertFailed: async (rows) => {
      const { error } = await supabase.from('notification_log').insert(rows)
      return { error: error?.message ?? null }
    },
  }
}

export async function invokeSendNotification(
  payload: BookingCreatedPayload,
  deps: InvokeSendNotificationDeps,
): Promise<InvokeSendNotificationOutcome> {
  return await invokeBookingCreatedWithRetry(payload, {
    url: `${envOr('SUPABASE_URL', deps.supabaseUrl)}/functions/v1/send-notification`,
    bearer: envOr('SUPABASE_SERVICE_ROLE_KEY', deps.serviceRoleKey),
    fetch: deps.fetch ?? fetch,
    sleep: deps.sleep ?? defaultSleep,
    captureWarning: deps.captureWarning,
    failureLog: failureLog(deps.supabase),
  })
}
