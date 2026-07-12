import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

/**
 * Outcome of orchestrating a booking refund:
 * - `none`      — nothing owed (amount ≤ 0, or the booking has no contact/client).
 * - `initiated` — refund_request created AND process-refund accepted it.
 * - `queued`    — refund_request created, but process-refund declined/failed
 *                 (e.g. -staff roles: the EF is admin-approval-tier only).
 *                 Recoverable from the Refunds page.
 * - `failed`    — the refund_request itself could not be recorded. NO Pending
 *                 row exists; the money is owed with no record and needs manual
 *                 processing.
 */
export type RefundOrchestrationState = 'none' | 'initiated' | 'queued' | 'failed'

export interface RefundOrchestrationInput {
  bookingId: string
  contactId: string | null
  clientId: string | null
  amountCents: number
  reason: string
}

/**
 * Raise a Pending `refund_request` for a booking and fire the `process-refund`
 * Edge Function with the caller's session JWT. Shared by every staff refund
 * site — cancel, inline quantity reduction, NCN resolution, NP resolution
 * (issue #389.1, the "extract when a 4th site appears" trigger).
 *
 * `process-refund` is approval-tier (contractor-admin / client-admin), so a
 * `-staff` caller legitimately lands `queued` (the Pending row waits for an
 * admin on the Refunds page). The caller has ALREADY applied the state change
 * (cancel/reduce/resolve) by the time this runs, so failures are surfaced via
 * the returned `state`, never thrown — `failed` means no Pending row exists.
 *
 * NOT a `'use server'` module: it takes the already-created server client so the
 * server actions (`'use server'`) can call it across the boundary. Uses direct
 * `fetch()` per CLAUDE.md §11 (supabase.functions.invoke is unreliable in SSR).
 */
export async function orchestrateRefund(
  supabase: SupabaseClient<Database>,
  input: RefundOrchestrationInput,
): Promise<{ state: RefundOrchestrationState }> {
  const { bookingId, contactId, clientId, amountCents, reason } = input
  if (amountCents <= 0 || !contactId || !clientId) return { state: 'none' }

  const { data: refundReq, error: insertError } = await supabase
    .from('refund_request')
    .insert({
      booking_id: bookingId,
      contact_id: contactId,
      client_id: clientId,
      amount_cents: amountCents,
      reason,
      status: 'Pending',
    })
    .select('id')
    .single()

  if (insertError || !refundReq) {
    console.error(
      `orchestrateRefund: failed to create refund_request for booking ${bookingId}:`,
      insertError?.message,
    )
    return { state: 'failed' }
  }

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) {
    // Pending row exists — recoverable from the Refunds page.
    return { state: 'queued' }
  }

  let res: Response
  try {
    res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/process-refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ refund_request_id: refundReq.id }),
    })
  } catch (err) {
    // Network-level rejection (DNS, connection refused) — must not throw past
    // this helper: the caller's state change has already committed. Pending row
    // exists, so recovery matches the non-OK path (Refunds page).
    console.error(
      `orchestrateRefund: process-refund fetch failed for booking ${bookingId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { state: 'queued' }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error')
    console.error(`orchestrateRefund: process-refund failed for booking ${bookingId}: ${errText}`)
    return { state: 'queued' }
  }

  return { state: 'initiated' }
}
