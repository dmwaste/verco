/**
 * SendGrid Event Webhook → notification_log delivery status (pure, Deno).
 *
 * Authoritative-for-the-EF copy. Keep in sync with the Node test mirror at
 * `src/lib/notifications/sendgrid-events.ts` (Vitest covers that one). VER-188.
 */

export type DeliveryStatus = 'delivered' | 'opened' | 'deferred' | 'bounced' | 'dropped' | 'spam'

const EVENT_TO_STATUS: Record<string, DeliveryStatus> = {
  delivered: 'delivered',
  open: 'opened',
  deferred: 'deferred',
  bounce: 'bounced',
  dropped: 'dropped',
  spamreport: 'spam',
}

export function sendgridEventToStatus(event: string): DeliveryStatus | null {
  return EVENT_TO_STATUS[event] ?? null
}

const RANK: Record<DeliveryStatus, number> = {
  bounced: 100,
  dropped: 100,
  spam: 100,
  deferred: 50,
  opened: 30,
  delivered: 20,
}

export function shouldApplyDeliveryStatus(current: DeliveryStatus | null, next: DeliveryStatus): boolean {
  if (current === null) return true
  return RANK[next] >= RANK[current]
}
