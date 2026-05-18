import type { BookingForDispatch, RenderedEmail, RenderedSMS } from './types'
import { renderEmailLayout } from './_layout'
import {
  buildBookingPortalUrl,
  escapeHtml,
  formatCollectionDate,
  formatCurrency,
  formatCollectionDateShort,
} from './template-helpers'

/**
 * `booking_created` template — sent on transition to Submitted.
 *
 * Fires via:
 *   - `create-booking` EF (free booking path — status = Submitted immediately)
 *   - `stripe-webhook` EF (paid booking path — Pending Payment → Submitted)
 *
 * The template does NOT fire on Pending Payment creation. Abandoned carts
 * never reach this point — they get `payment_reminder` (Phase 4) then
 * `payment_expired` (Phase 4) instead.
 *
 * ## Content
 *
 *   Heading: "Booking confirmed"
 *   Body:
 *     - Brief confirmation line
 *     - Details table: ref, collection date, address
 *     - Services section header + one row per service (free/paid counts)
 *     - (if total_charge_cents > 0) Total paid line
 *   CTA: "View booking" → resolves to client.custom_domain / {slug}.verco.au /
 *        appUrl fallback via buildBookingPortalUrl (Verco uses hostname-based
 *        tenant routing, so appUrl+slug path concatenation is broken).
 *
 * ## Pure function
 *
 * Takes booking + appUrl, returns `{ subject, html }`. Mirrored to
 * `supabase/functions/_shared/templates/booking-created.ts` — kept in sync
 * by the template-sync CI job.
 */

export function renderBookingCreated(
  booking: BookingForDispatch,
  appUrl: string
): RenderedEmail {
  const ref = booking.ref
  const dateStr = formatCollectionDate(booking.collection_date)
  const address = booking.address

  // Group items by service_name, summing free and paid quantities separately.
  const grouped = new Map<
    string,
    { free: number; paid: number; paidCents: number }
  >()
  for (const item of booking.items) {
    const existing = grouped.get(item.service_name) ?? {
      free: 0,
      paid: 0,
      paidCents: 0,
    }
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
      if (counts.paid > 0)
        parts.push(`${counts.paid} paid (${formatCurrency(counts.paidCents)})`)
      return `<tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">${escapeHtml(name)}</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${parts.join(' · ')}</td></tr>`
    })
    .join('')

  // Services section header — separates the booking metadata (ref, date,
  // address) from the per-service line items. The colspan=2 row spans both
  // columns so the "Services" label sits flush-left with a subtle divider.
  const servicesHeader =
    itemRows.length > 0
      ? `<tr><td colspan="2" style="padding:14px 0 6px 0;color:#293F52;font-size:13px;font-weight:600;border-top:1px solid #F0F2F5">Services</td></tr>`
      : ''

  const totalRow =
    booking.total_charge_cents > 0
      ? `<tr><td style="padding:12px 12px 0 0;color:#293F52;font-size:13px;font-weight:600;border-top:1px solid #F0F2F5">Total paid</td><td style="padding:12px 0 0 0;color:#293F52;font-size:13px;font-weight:600;text-align:right;border-top:1px solid #F0F2F5">${formatCurrency(booking.total_charge_cents)}</td></tr>`
      : ''

  const bodyHtml = `
    <p style="margin:0 0 16px 0">Thanks — your verge collection is booked. Here are the details:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse">
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Reference</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right;font-family:'SF Mono',monospace">${escapeHtml(ref)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Collection date</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(dateStr)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap;vertical-align:top">Address</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(address)}</td></tr>
      ${servicesHeader}
      ${itemRows}
      ${totalRow}
    </table>
    <p style="margin:0 0 16px 0">You'll get another email closer to the date with a reminder to put your waste on the verge.</p>
  `

  const ctaUrl = buildBookingPortalUrl(
    booking.client,
    `/booking/${encodeURIComponent(ref)}`,
    appUrl,
  )

  return {
    subject: `Booking confirmed — ${ref}`,
    html: renderEmailLayout({
      client: booking.client,
      preheader: `Your verge collection is booked for ${dateStr}`,
      heading: 'Booking confirmed',
      bodyHtml,
      ctaText: 'View booking',
      ctaUrl,
    }),
  }
}

/**
 * SMS variant of `booking_created`. Targets ≤160 GSM-7 chars so the message
 * fits in one segment (one billable Twilio unit). Alpha sender name takes
 * care of identification — body skips the "From Verco:" prefix.
 *
 * Example:
 *   "Booking confirmed — COT-E88PNN for Wed 20 May. Details: verco.au/b/COT-E88PNN"
 *   = 75 chars (one segment, plenty of room).
 *
 * `appUrl` is intentionally ignored — the SMS link always goes through the
 * canonical `verco.au/b/<ref>` redirect endpoint regardless of where the
 * booking actually lives, so SMS links remain stable across tenant rebrands.
 */
export function renderBookingCreatedSMS(
  booking: BookingForDispatch,
): RenderedSMS {
  const ref = booking.ref
  const dateStr = formatCollectionDateShort(booking.collection_date)
  const link = `verco.au/b/${encodeURIComponent(ref)}`
  return {
    body: `Booking confirmed — ${ref} for ${dateStr}. Details: ${link}`,
  }
}
