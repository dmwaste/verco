import type { BookingForDispatch, RenderedEmail } from './types'
import { renderEmailLayout } from './_layout'
import {
  buildBookingPortalUrl,
  escapeHtml,
  formatCollectionDate,
  formatCurrency,
} from './template-helpers'

/**
 * `booking_updated` template — sent when a resident-meaningful edit is made to a
 * Confirmed booking (a staff quantity change, or a date/location change). Fired
 * by the admin server actions (`updateBookingQuantities`, `updateCollectionDetails`).
 *
 * Deliberately a CURRENT-STATE SNAPSHOT (a copy of `booking_created`), not a
 * diff: showing "here is your booking as it now stands" is self-describing and
 * avoids writing readable prose for every possible edit. When a quantity
 * reduction sent money back, a refund block (mirrored from `booking_cancelled`)
 * explains the money — otherwise the resident sees a refund on their card with
 * no context. The refund amount is the reduction DELTA (`refundCents`), not the
 * booking total, so it is passed in rather than read from the booking.
 *
 * Email-only (SMS Phase 1 covers booking_created + collection_reminder only).
 * Pure function; mirrored to src/lib/notifications/templates by sync-mirrors.sh.
 */

export interface RenderBookingUpdatedOptions {
  /** Reduction refund amount in cents (the delta), when the edit sent money back. */
  refundCents?: number
  /** Which refund copy variant to show (omit for edits with no refund). */
  refundStatus?: 'processed' | 'pending_review'
}

export function renderBookingUpdated(
  booking: BookingForDispatch,
  appUrl: string,
  options: RenderBookingUpdatedOptions = {},
): RenderedEmail {
  const ref = booking.ref
  const dateStr = formatCollectionDate(booking.collection_date)
  const address = booking.address

  // Group items by service_name, summing free and paid quantities separately
  // (identical to booking_created — the current state of the booking's services).
  const grouped = new Map<string, { free: number; paid: number; paidCents: number }>()
  for (const item of booking.items) {
    const existing = grouped.get(item.service_name) ?? { free: 0, paid: 0, paidCents: 0 }
    if (item.is_extra) {
      existing.paid += item.no_services
      existing.paidCents += item.line_charge_cents
    } else {
      existing.free += item.no_services
    }
    grouped.set(item.service_name, existing)
  }

  const itemRows = Array.from(grouped.entries())
    .map(([name, counts]) => {
      const parts: string[] = []
      if (counts.free > 0) parts.push(`${counts.free} included`)
      if (counts.paid > 0) parts.push(`${counts.paid} paid (${formatCurrency(counts.paidCents)})`)
      return `<tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">${escapeHtml(name)}</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${parts.join(' · ')}</td></tr>`
    })
    .join('')

  const servicesHeader =
    itemRows.length > 0
      ? `<tr><td colspan="2" style="padding:14px 0 6px 0;color:#293F52;font-size:13px;font-weight:600;border-top:1px solid #F0F2F5">Services</td></tr>`
      : ''

  const totalRow =
    booking.total_charge_cents > 0
      ? `<tr><td style="padding:12px 12px 0 0;color:#293F52;font-size:13px;font-weight:600;border-top:1px solid #F0F2F5">Total paid</td><td style="padding:12px 0 0 0;color:#293F52;font-size:13px;font-weight:600;text-align:right;border-top:1px solid #F0F2F5">${formatCurrency(booking.total_charge_cents)}</td></tr>`
      : ''

  const refundCents = options.refundCents ?? 0
  let refundBlock = ''
  if (refundCents > 0 && options.refundStatus === 'processed') {
    refundBlock = `<p style="margin:0 0 16px 0">A refund of <strong>${formatCurrency(refundCents)}</strong> for the removed items has been processed to your original payment method. It should appear within 1–3 business days.</p>`
  } else if (refundCents > 0 && options.refundStatus === 'pending_review') {
    refundBlock = `<p style="margin:0 0 16px 0">A refund of <strong>${formatCurrency(refundCents)}</strong> for the removed items will be reviewed by our team. We'll be in touch once it's processed.</p>`
  }

  const bodyHtml = `
    <p style="margin:0 0 16px 0">Your verge collection booking has been updated. Here are the current details:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse">
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Reference</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right;font-family:'SF Mono',monospace">${escapeHtml(ref)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Collection date</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(dateStr)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap;vertical-align:top">Address</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(address)}</td></tr>
      ${servicesHeader}
      ${itemRows}
      ${totalRow}
    </table>
    ${refundBlock}
    <p style="margin:0 0 16px 0">If you didn't expect this change, reply to this email and we'll take a look.</p>
  `

  const ctaUrl = buildBookingPortalUrl(booking.client, `/booking/${encodeURIComponent(ref)}`, appUrl)

  return {
    subject: `Booking updated — ${ref}`,
    html: renderEmailLayout({
      client: booking.client,
      preheader: `Your verge collection booking ${ref} has been updated`,
      heading: 'Booking updated',
      bodyHtml,
      ctaText: 'View booking',
      ctaUrl,
    }),
  }
}
