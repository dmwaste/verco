import type { BookingForDispatch, RenderedEmail } from './types.ts'
import { renderEmailLayout } from './_layout.ts'
import { formatCurrency, formatCollectionDate, escapeHtml, buildBookingPortalUrl } from './template-helpers.ts'

/**
 * `booking_cancelled` template — sent when a user or staff member cancels.
 *
 * Fires via:
 *   - Admin cancel action (`cancelBooking` in admin/bookings/[id]/actions.ts)
 *   - Resident cancel action (Phase 2 / VER-120)
 *   - Refund-triggered cancel path (Phase 2 / VER-120)
 *
 * Does NOT fire for abandoned-cart expiry — that's `payment_expired` in
 * Phase 4 with different copy ("no charge was made") instead of apology.
 *
 * ## Content
 *
 *   Heading: "Booking cancelled"
 *   Body:
 *     - Confirmation line
 *     - Optional reason (from `reason` field in payload — interpolated if present)
 *     - Details: ref, original collection date, address
 *     - (if refund_status set) Refund notice
 *   CTA: "Book again" → tenant-host /dashboard via buildBookingPortalUrl
 *
 * Phase 1 scope is the simplest variant: free booking + optional reason +
 * refund mention. Phase 2 (VER-120) adds the residents' and refund-triggered
 * variants if additional template branches are needed.
 */

export interface RenderBookingCancelledOptions {
  /** Optional cancellation reason — shown in body if set */
  reason?: string | undefined
  /** Refund status — controls which refund copy variant appears */
  refund_status?: 'processed' | 'pending_review' | undefined
}

export function renderBookingCancelled(
  booking: BookingForDispatch,
  appUrl: string,
  options: RenderBookingCancelledOptions = {}
): RenderedEmail {
  const ref = booking.ref
  const dateStr = formatCollectionDate(booking.collection_date)
  const address = booking.address
  const refundAmount = booking.total_charge_cents

  const reasonBlock = options.reason
    ? `<p style="margin:0 0 16px 0;padding:12px 16px;background:#F8F9FA;border-left:3px solid #8FA5B8;color:#293F52;font-size:14px"><strong>Reason:</strong> ${escapeHtml(options.reason)}</p>`
    : ''

  let refundBlock = ''
  if (refundAmount > 0 && options.refund_status === 'processed') {
    refundBlock = `<p style="margin:0 0 16px 0">A refund of <strong>${formatCurrency(refundAmount)}</strong> has been processed to your original payment method. It should appear within 1–3 business days.</p>`
  } else if (refundAmount > 0 && options.refund_status === 'pending_review') {
    refundBlock = `<p style="margin:0 0 16px 0">Your refund of <strong>${formatCurrency(refundAmount)}</strong> will be reviewed by our team. We'll be in touch once it's processed.</p>`
  }

  const bodyHtml = `
    <p style="margin:0 0 16px 0">Your verge collection booking has been cancelled.</p>
    ${reasonBlock}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse">
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Reference</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right;font-family:'SF Mono',monospace">${escapeHtml(ref)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Scheduled for</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(dateStr)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap;vertical-align:top">Address</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(address)}</td></tr>
    </table>
    ${refundBlock}
    <p style="margin:0 0 16px 0">You can book another collection any time.</p>
  `

  const ctaUrl = buildBookingPortalUrl(booking.client, '/dashboard', appUrl)

  return {
    subject: `Booking cancelled — ${ref}`,
    html: renderEmailLayout({
      client: booking.client,
      preheader: `Your booking ${ref} has been cancelled`,
      heading: 'Booking cancelled',
      bodyHtml,
      ctaText: 'Book again',
      ctaUrl,
    }),
  }
}
