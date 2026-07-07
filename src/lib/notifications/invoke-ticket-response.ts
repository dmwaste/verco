import type { createClient } from '@/lib/supabase/client'

type SupabaseBrowserClient = ReturnType<typeof createClient>

/**
 * Fire-and-forget POST to the notify-ticket-response Edge Function from the
 * admin ticket UI. Called after a successful PUBLIC staff reply insert.
 *
 * Uses the user's session access token (anon-key world — CLAUDE.md §20); the
 * EF validates the caller's staff role AND tenant before sending. Never
 * throws: the reply has already committed and must not be broken by a
 * notification failure.
 */
export async function invokeNotifyTicketResponse(
  supabase: SupabaseBrowserClient,
  ticketResponseId: string,
): Promise<void> {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
    if (!supabaseUrl) {
      console.error('[notifications] NEXT_PUBLIC_SUPABASE_URL not set — skipping notify-ticket-response')
      return
    }
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.access_token) {
      console.error('[notifications] No session access token — skipping notify-ticket-response')
      return
    }
    const res = await fetch(`${supabaseUrl}/functions/v1/notify-ticket-response`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ticket_response_id: ticketResponseId }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)')
      console.error(
        `[notifications] notify-ticket-response returned ${res.status} for ${ticketResponseId}: ${body}`,
      )
    }
  } catch (err) {
    console.error(
      `[notifications] Failed to invoke notify-ticket-response for ${ticketResponseId}:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
