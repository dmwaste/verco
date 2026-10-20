import * as Sentry from '@sentry/nextjs'
import type { createClient } from '@/lib/supabase/client'
import { describeAttempt, postWithRetry } from './post-retry'

type SupabaseBrowserClient = ReturnType<typeof createClient>

/**
 * What the admin ticket page tells the staff member who replied.
 * `not_sent` = the email didn't go out (offer Resend); `no_email` = the
 * resident has no email address on file, so there is nothing to retry.
 */
export type TicketReplyEmailOutcome = { ok: true } | { ok: false; reason: 'not_sent' | 'no_email' }

export interface InvokeTicketResponseOptions {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  captureWarning?: (message: string, extra?: Record<string, unknown>) => void
}

/**
 * Email the resident a PUBLIC staff reply via the notify-ticket-response Edge
 * Function, from the admin ticket UI. Called after the reply insert commits.
 *
 * Uses the user's session access token (anon-key world — CLAUDE.md §20); the
 * EF validates the caller's staff role AND tenant before sending. Retries
 * gateway failures (./post-retry.ts) — safe because the EF claims the send
 * before making it, so a retry or a Resend can never email the resident twice
 * (#671). Never throws: the reply has already committed. Resolves with the
 * outcome so the page can say when the email didn't go out; a PII-free Sentry
 * warning (ids + status only) records it too.
 */
export async function invokeNotifyTicketResponse(
  supabase: SupabaseBrowserClient,
  ticketResponseId: string,
  opts: InvokeTicketResponseOptions = {},
): Promise<TicketReplyEmailOutcome> {
  const captureWarning =
    opts.captureWarning ??
    ((message, extra) => {
      Sentry.captureMessage(message, { level: 'warning', extra })
    })
  const notSent = (detail: string, extra: Record<string, unknown>): TicketReplyEmailOutcome => {
    console.error(`[notifications] notify-ticket-response for ${ticketResponseId}: ${detail}`)
    captureWarning('ticket_response email not sent', { ticket_response_id: ticketResponseId, ...extra })
    return { ok: false, reason: 'not_sent' }
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!supabaseUrl || !session?.access_token) {
      return notSent('no Supabase URL or session token — not called', { http_status: null, attempts: 0 })
    }

    const res = await postWithRetry(
      { ticket_response_id: ticketResponseId },
      {
        url: `${supabaseUrl}/functions/v1/notify-ticket-response`,
        bearer: session.access_token,
        fetch: opts.fetch ?? fetch,
        sleep: opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
        label: `notify-ticket-response ${ticketResponseId}`,
      },
    )
    if (!res.ok) {
      return notSent(describeAttempt(res.last), {
        http_status: res.last.kind === 'http' ? res.last.status : null,
        attempts: res.attempts,
      })
    }

    // 200 on every non-crash path; `status` says what the EF did.
    const efStatus = efStatusOf(res.body)
    if (efStatus === 'sent' || efStatus === 'skipped') return { ok: true }
    if (efStatus === 'no_email') return { ok: false, reason: 'no_email' }
    return notSent(`EF reported ${efStatus ?? 'an unreadable response'}`, {
      http_status: 200,
      attempts: res.attempts,
      ef_status: efStatus,
    })
  } catch (err) {
    return notSent(err instanceof Error ? err.message : String(err), { http_status: null })
  }
}

function efStatusOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed && typeof parsed === 'object' && 'status' in parsed && typeof parsed.status === 'string'
      ? parsed.status
      : null
  } catch {
    return null
  }
}
