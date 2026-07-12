/**
 * Amount guard for the `stripe-webhook` charge.refunded BACKSTOP (#387.2).
 *
 * process-refund (the primary path) sets a `refund_request` Approved
 * synchronously, so this handler only fires for refunds initiated DIRECTLY in
 * Stripe. It picks the OLDEST Pending `refund_request` for the booking
 * (`ORDER BY created_at ASC` — a booking can carry several once a full cancel
 * and a quantity-reduction refund coexist). Auto-approving that oldest request
 * blindly would settle the WRONG request when the Stripe refund is actually
 * sized for a different one, so we only auto-approve when the refund amount
 * EXACTLY matches the selected request; otherwise the handler leaves everything
 * Pending for a human to reconcile.
 *
 * This is the pure decision — no I/O — so the money rule is unit-testable in
 * isolation from the webhook plumbing (the oldest-Pending SELECT stays in the
 * EF). Mirror of src/lib/payments/refund-auto-approve.ts (kept in sync by
 * scripts/sync-mirrors.sh — _shared is the source of truth).
 *
 * @param latestRefundCents The Stripe refund amount in cents, or null when the
 *   webhook could not read one (never auto-approve on a missing amount).
 * @param requestAmountCents The `amount_cents` of the oldest Pending
 *   `refund_request` selected for this booking.
 */
export function shouldAutoApproveRefund(
  latestRefundCents: number | null,
  requestAmountCents: number,
): boolean {
  return latestRefundCents != null && latestRefundCents === requestAmountCents
}
