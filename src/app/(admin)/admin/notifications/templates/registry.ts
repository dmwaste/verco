import type { NotificationType } from '@/lib/notifications/templates/types'

/**
 * Catalog entry for the notification-templates admin surface.
 *
 * One row per `NotificationType`. The catalog list page reads this to build
 * the card grid; the detail page reads it to label the preview and resolve
 * the source-file path on disk (`fs.readFile`) + the GitHub web-editor URL.
 *
 * `channels` is the source of truth for "does this type have an SMS variant"
 * — it must match the `renderSmsTemplate()` switch in `_shared/dispatch.ts`.
 */
export interface TemplateCatalogEntry {
  type: NotificationType
  label: string
  description: string
  channels: ('email' | 'sms')[]
  /** Path relative to repo root — used for both `fs.readFile` and GitHub deep-link */
  sourceFile: string
}

export const TEMPLATE_CATALOG: TemplateCatalogEntry[] = [
  {
    type: 'booking_created',
    label: 'Booking confirmed',
    description:
      'Sent immediately after a booking is created (free) or after Stripe confirms payment (paid). Includes ref, collection date, address, services breakdown, and total paid.',
    channels: ['email', 'sms'],
    sourceFile: 'src/lib/notifications/templates/booking-created.ts',
  },
  {
    type: 'booking_updated',
    label: 'Booking updated',
    description:
      'Sent when a Confirmed booking is edited by staff (a quantity change or a date/location change). A current-state snapshot of the booking, plus a refund line when a reduction sent money back. Not sent for post-dispatch date corrections or bookings still awaiting payment (Pending Payment).',
    channels: ['email'],
    sourceFile: 'src/lib/notifications/templates/booking-updated.ts',
  },
  {
    type: 'collection_reminder',
    label: 'Collection reminder',
    description:
      'Sent N days before the collection date — N is per-tenant via client.sms_reminder_days_before. Reminds residents to place items on the verge by 6am.',
    channels: ['email', 'sms'],
    sourceFile: 'src/lib/notifications/templates/collection-reminder.ts',
  },
  {
    type: 'booking_cancelled',
    label: 'Booking cancelled',
    description:
      'Sent when a booking is cancelled by staff or the resident. Includes optional reason and refund status (processed / pending_review).',
    channels: ['email'],
    sourceFile: 'src/lib/notifications/templates/booking-cancelled.ts',
  },
  {
    type: 'payment_reminder',
    label: 'Payment reminder',
    description:
      'Sent to residents whose paid booking is still in Pending Payment 12 hours after creation. Includes a deep link back to the Stripe checkout session.',
    channels: ['email'],
    sourceFile: 'src/lib/notifications/templates/payment-reminder.ts',
  },
  {
    type: 'payment_expired',
    label: 'Payment expired',
    description:
      'Sent when the 24-hour Pending Payment window closes without a successful payment. Booking is auto-cancelled — no charge.',
    channels: ['email'],
    sourceFile: 'src/lib/notifications/templates/payment-expired.ts',
  },
  {
    type: 'ncn_raised',
    label: 'Non-conformance notice raised',
    description:
      'Sent when field staff raises an NCN against a booking. Includes reason, notes, photos, and a dispute link valid for 14 days.',
    channels: ['email'],
    sourceFile: 'src/lib/notifications/templates/ncn-raised.ts',
  },
  {
    type: 'np_raised',
    label: 'Nothing presented',
    description:
      'Sent when field staff arrives at a booking and finds no items on the verge. Includes a rebooking CTA.',
    channels: ['email'],
    sourceFile: 'src/lib/notifications/templates/np-raised.ts',
  },
  {
    type: 'completion_survey',
    label: 'Completion survey',
    description:
      'Sent after a successful collection inviting the resident to give feedback. Token-gated single-use link.',
    channels: ['email'],
    sourceFile: 'src/lib/notifications/templates/completion-survey.ts',
  },
]

export function getCatalogEntry(type: string): TemplateCatalogEntry | null {
  return TEMPLATE_CATALOG.find((t) => t.type === type) ?? null
}
