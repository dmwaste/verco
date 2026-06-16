import type { BookingForDispatch, RenderedEmail } from './types.ts'
import { renderEmailLayout } from './_layout.ts'
import { formatCollectionDate, escapeHtml, buildBookingPortalUrl } from './template-helpers.ts'

/**
 * `payment_expired` template — sent when a `Pending Payment` booking is
 * auto-cancelled after 24 hours without a completed Stripe payment.
 *
 * Explicitly states "No charge has been made" to reassure the resident.
 * CTA links to the client dashboard so they can rebook immediately.
 *
 * ## Pure function
 *
 * Takes booking + appUrl, returns `{ subject, html }`. Kept in sync with its
 * Node/Deno mirror by the template-sync CI job.
 */

export function renderPaymentExpired(
  booking: BookingForDispatch,
  appUrl: string
): RenderedEmail {
  const ref = booking.ref
  const dateStr = formatCollectionDate(booking.collection_date)
  const address = booking.address

  const bodyHtml = `
    <p style="margin:0 0 16px 0">Your verge collection booking has expired because payment wasn't completed within 24 hours.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse">
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Reference</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right;font-family:'SF Mono',monospace">${escapeHtml(ref)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Collection date</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(dateStr)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap;vertical-align:top">Address</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(address)}</td></tr>
    </table>
    <p style="margin:0 0 16px 0">No charge has been made to your payment method.</p>
    <p style="margin:0 0 16px 0">You can book another collection any time.</p>
  `

  const ctaUrl = buildBookingPortalUrl(booking.client, '/dashboard', appUrl)

  return {
    subject: `Booking expired — ${ref}`,
    html: renderEmailLayout({
      client: booking.client,
      preheader: `Your booking ${ref} has expired — no charge was made`,
      heading: 'Booking expired',
      bodyHtml,
      ctaText: 'Book again',
      ctaUrl,
    }),
  }
}
