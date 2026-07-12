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

/**
 * Resolve the latest Stripe refund for a `charge.refunded` event, tolerating the
 * modern webhook payload shape.
 *
 * A `charge.refunded` webhook PAYLOAD follows the WEBHOOK ENDPOINT's pinned
 * Stripe API version — NOT the SDK's `apiVersion`. On API versions >= 2022-11-15
 * the embedded `charge.refunds` list is OMITTED from the payload, so
 * `charge.refunds.data[0]` is undefined and the backstop reads a null amount →
 * `shouldAutoApproveRefund` is never satisfied → every direct-in-Stripe refund
 * silently parks Pending. Prefer the embed when present; otherwise fall back to
 * the injected fetcher (the EF passes `stripe.refunds.list({ charge })`).
 *
 * Pure control flow with the I/O injected, so the embed-vs-fetch decision is
 * unit-testable without the Stripe SDK. Generic over the refund shape to avoid a
 * Stripe type import (keeps this file a byte-identical mirror of
 * src/lib/payments/refund-auto-approve.ts). Returns null when neither source
 * yields a refund — the caller parks Pending and emits a Sentry warning.
 *
 * @param embedded The refund embedded in the webhook payload, or undefined when
 *   the endpoint's API version omits the `charge.refunds` list.
 * @param fetchLatest Fetches the most-recent refund for the charge from Stripe;
 *   returns null when the charge has no refunds.
 */
export async function resolveLatestRefund<T>(
  embedded: T | undefined,
  fetchLatest: () => Promise<T | null>,
): Promise<T | null> {
  if (embedded) return embedded
  return await fetchLatest()
}
