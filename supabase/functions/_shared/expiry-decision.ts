// Expiry decision logic mirrored in src/lib/payments/expiry-decision.ts — keep
// in sync (scripts/sync-mirrors.sh; _shared/ is the source of truth).

/**
 * Pure decision table for handle-expired-payments (VER-252).
 *
 * Decides what to do with a Pending Payment booking before dunning (6h loop)
 * or cancelling (24h loop), given its booking_payment rows and the Stripe
 * payment status of each session. ALL payment rows are considered — during a
 * webhook outage, create-checkout's session-reuse path can shelve a PAID
 * session's row as 'expired' and mint a fresh one, so the newest row alone
 * is not trustworthy.
 *
 * Fail-safe rule: a paid signal anywhere wins (reconcile); an unverifiable
 * session (Stripe lookup error) means SKIP — never cancel or dun a booking
 * we couldn't verify.
 */

export interface ExpiryPaymentRow {
  stripe_session_id: string | null
  /** booking_payment.status — 'pending' | 'paid' | 'expired' | ... */
  status: string
}

export type SessionPaidStatus = 'paid' | 'unpaid' | 'error'

export type ExpiryAction =
  | { action: 'cancel' }
  | { action: 'reconcile'; sessionId: string }
  | { action: 'skip' }

export function decideExpiryAction(
  payments: ExpiryPaymentRow[],
  sessionStatuses: ReadonlyMap<string, SessionPaidStatus>
): ExpiryAction {
  // A DB row already marked paid means the webhook (or a prior reconcile)
  // recorded payment but the booking is still Pending Payment — fix the
  // booking, never cancel it.
  const paidRow = payments.find((p) => p.status === 'paid' && p.stripe_session_id)
  if (paidRow?.stripe_session_id) {
    return { action: 'reconcile', sessionId: paidRow.stripe_session_id }
  }

  const sessionIds = payments
    .map((p) => p.stripe_session_id)
    .filter((id): id is string => id !== null)

  // No Stripe sessions at all — nothing to verify, age-based handling stands.
  if (sessionIds.length === 0) {
    return { action: 'cancel' }
  }

  // Any paid session wins, even one whose row was shelved as 'expired'.
  const paidSessionId = sessionIds.find((id) => sessionStatuses.get(id) === 'paid')
  if (paidSessionId) {
    return { action: 'reconcile', sessionId: paidSessionId }
  }

  // Couldn't verify every session — do nothing this cycle.
  if (sessionIds.some((id) => sessionStatuses.get(id) !== 'unpaid')) {
    return { action: 'skip' }
  }

  return { action: 'cancel' }
}
