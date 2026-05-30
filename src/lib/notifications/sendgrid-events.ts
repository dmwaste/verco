/**
 * SendGrid Event Webhook → notification_log delivery status (pure).
 *
 * Node-testable mirror of the Deno copy at `supabase/functions/_shared/sendgrid-events.ts`
 * (the `src/lib/pricing` ↔ `_shared/pricing.ts` pattern — keep the two in sync). The
 * `sendgrid-webhook` Edge Function imports the Deno copy; Vitest covers this one.
 *
 * Writes to `notification_log.delivery_status` (NOT `status` — that's the send lifecycle
 * `queued|sent|failed`, read by the re-send idempotency guard). VER-188.
 */

/** Delivery states we surface from SendGrid events. */
export type DeliveryStatus = 'delivered' | 'opened' | 'deferred' | 'bounced' | 'dropped' | 'spam'

/** The SendGrid event types subscribed for UAT (click intentionally skipped — volume). */
const EVENT_TO_STATUS: Record<string, DeliveryStatus> = {
  delivered: 'delivered',
  open: 'opened',
  deferred: 'deferred',
  bounce: 'bounced',
  dropped: 'dropped',
  spamreport: 'spam',
}

/** Map a SendGrid `event` field to a delivery status, or null for events we ignore (processed, click, …). */
export function sendgridEventToStatus(event: string): DeliveryStatus | null {
  return EVENT_TO_STATUS[event] ?? null
}

/**
 * Significance rank. Terminal-negative states win so an out-of-order or later positive
 * event (SendGrid delivers events asynchronously, sometimes reordered) never masks a bounce/spam.
 */
const RANK: Record<DeliveryStatus, number> = {
  bounced: 100,
  dropped: 100,
  spam: 100,
  deferred: 50,
  opened: 30,
  delivered: 20,
}

export function deliveryStatusRank(s: DeliveryStatus): number {
  return RANK[s]
}

/**
 * Whether `next` should overwrite the row's `current` delivery status.
 * Null current always applies; otherwise only equal-or-higher significance (never downgrade
 * a bounce to a stray later "delivered").
 */
export function shouldApplyDeliveryStatus(current: DeliveryStatus | null, next: DeliveryStatus): boolean {
  if (current === null) return true
  return RANK[next] >= RANK[current]
}

/** True for states that indicate the address is (currently) undeliverable / flagged. */
export function isNegativeDeliveryStatus(s: DeliveryStatus): boolean {
  return RANK[s] >= 100
}
