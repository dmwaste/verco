import * as Sentry from '@sentry/nextjs'
import { createClient } from '@/lib/supabase/server'
import type { NotificationPayload, NotificationResumePayload } from './templates/types'
import {
  FAILURE_TARGET_SELECT,
  invokeBookingCreatedWithRetry,
  toFailureTarget,
  type FailureLog,
  type InvokeOutcome,
} from './notify-retry'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export interface InvokeBookingCreatedOptions {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  captureWarning?: (message: string, extra?: Record<string, unknown>) => void
}

/**
 * Fire `booking_created` for a booking staff just created in admin (the MUD
 * booking path, #671) — AWAITED, retried, and recorded on final failure, the
 * same contract the Edge Functions get from `_shared/invoke-send-notification.ts`
 * (see `./notify-retry.ts`). Posts with the staff member's session token, and
 * the `failed` rows are written under their own RLS
 * (`notification_log_staff_insert_failed`). Never throws: the booking is
 * already committed, so a notification failure must not fail the action.
 */
export async function invokeBookingCreated(
  supabase: SupabaseServerClient,
  bookingId: string,
  opts: InvokeBookingCreatedOptions = {},
): Promise<InvokeOutcome> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  let bearer: string | null = null
  try {
    const { data } = await supabase.auth.getSession()
    bearer = supabaseUrl ? (data.session?.access_token ?? null) : null
  } catch (err) {
    console.error('[notifications] could not read the session for booking_created:', err instanceof Error ? err.message : String(err))
  }

  return await invokeBookingCreatedWithRetry(
    { type: 'booking_created', booking_id: bookingId },
    {
      url: `${supabaseUrl}/functions/v1/send-notification`,
      bearer,
      fetch: opts.fetch ?? fetch,
      sleep: opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      captureWarning:
        opts.captureWarning ??
        ((message, extra) => {
          Sentry.captureMessage(message, { level: 'warning', extra })
        }),
      failureLog: userFailureLog(supabase),
    },
  )
}

/** notification_log access for the failure rows, under the caller's own RLS. */
function userFailureLog(supabase: SupabaseServerClient): FailureLog {
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

/**
 * Fire-and-forget POST to the send-notification Edge Function.
 *
 * Uses the user's session access token (not service role — CLAUDE.md §20).
 * The EF accepts user JWTs and validates the role before dispatching.
 *
 * Accepts either a standard payload (for new notifications) or a resume
 * payload (for retry by notification_log_id).
 *
 * Fire-and-forget: the caller's primary operation has already committed.
 * Notification failure is logged but never propagated.
 */
export async function invokeSendNotification(
  supabase: SupabaseServerClient,
  input: NotificationPayload | NotificationResumePayload
): Promise<void> {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
    if (!supabaseUrl) {
      console.error(
        '[notifications] NEXT_PUBLIC_SUPABASE_URL not set — skipping send-notification'
      )
      return
    }
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.access_token) {
      console.error(
        '[notifications] No session access token — skipping send-notification'
      )
      return
    }
    const res = await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)')
      const label =
        'type' in input
          ? `${input.type} ${input.booking_id}`
          : `retry ${input.notification_log_id}`
      console.error(
        `[notifications] send-notification returned ${res.status} for ${label}: ${body}`
      )
    }
  } catch (err) {
    const label = 'type' in input ? `${input.type}` : 'retry'
    console.error(
      `[notifications] Failed to invoke send-notification for ${label}:`,
      err instanceof Error ? err.message : String(err)
    )
  }
}
