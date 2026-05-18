import type {
  BookingForDispatch,
  RenderedEmail,
  RenderedSMS,
} from './types.ts'
import { renderEmailLayout } from './_layout.ts'
import {
  buildBookingPortalUrl,
  buildSmsBookingLink,
  escapeHtml,
  formatCollectionDate,
  formatCollectionDateShort,
} from './template-helpers.ts'

/**
 * `collection_reminder` template — sent N days before a booking's
 * collection_date, where N is `client.sms_reminder_days_before`. Fired by
 * the `send-collection-reminders` daily cron at 09:00 AWST.
 *
 * The naming is historical — the field originally implied SMS-only, but
 * the actual reminder fans out to both email and SMS via the dispatcher's
 * channel branching. Both channels fire when the contact has both email
 * and `mobile_e164`. Tenants with `sms_reminder_days_before = NULL` skip
 * the reminder entirely (explicit opt-in per tenant).
 *
 * ## Content
 *
 *   Email:
 *     Heading: "Verge collection on {date}"
 *     Body:
 *       - Reminder line with date + address
 *       - Service summary (free + paid grouped by service)
 *       - "Place items on the verge by 7am" line
 *     CTA: "View booking" → tenant booking page
 *
 *   SMS:
 *     "Reminder: verge collection at {short addr} on {Wed 20 May}.
 *      Items out by 7am. verco.au/b/{ref}"
 *
 * Mirrored to `src/lib/notifications/templates/collection-reminder.ts` and
 * enforced in sync by the template-sync CI job.
 */

export function renderCollectionReminder(
  booking: BookingForDispatch,
  appUrl: string,
): RenderedEmail {
  const ref = booking.ref
  const dateStr = formatCollectionDate(booking.collection_date)
  const address = booking.address

  // Group items by service_name — just total count for the reminder, no need
  // to split free/paid (resident already paid at booking time if applicable).
  const grouped = new Map<string, number>()
  for (const item of booking.items) {
    grouped.set(
      item.service_name,
      (grouped.get(item.service_name) ?? 0) + item.no_services,
    )
  }

  const itemRows = Array.from(grouped.entries())
    .map(
      ([name, qty]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">${escapeHtml(name)}</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${qty}</td></tr>`,
    )
    .join('')

  const servicesHeader =
    itemRows.length > 0
      ? `<tr><td colspan="2" style="padding:14px 0 6px 0;color:#293F52;font-size:13px;font-weight:600;border-top:1px solid #F0F2F5">Services</td></tr>`
      : ''

  const bodyHtml = `
    <p style="margin:0 0 16px 0">A reminder that your verge collection is scheduled for <strong>${escapeHtml(dateStr)}</strong>.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse">
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Reference</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right;font-family:'SF Mono',monospace">${escapeHtml(ref)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap;vertical-align:top">Address</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(address)}</td></tr>
      ${servicesHeader}
      ${itemRows}
    </table>
    <p style="margin:0 0 16px 0"><strong>Place your items on the verge by 7am</strong> on the morning of collection — or the night before if it's easier.</p>
    <p style="margin:0 0 16px 0;color:#8FA5B8;font-size:13px">Need to make a change? Use the link below to view or cancel up to 3:30pm the day before.</p>
  `

  const ctaUrl = buildBookingPortalUrl(
    booking.client,
    `/booking/${encodeURIComponent(ref)}`,
    appUrl,
  )

  return {
    subject: `Verge collection reminder — ${dateStr}`,
    html: renderEmailLayout({
      client: booking.client,
      preheader: `Your verge collection is on ${dateStr} — items out by 7am`,
      heading: 'Verge collection reminder',
      bodyHtml,
      ctaText: 'View booking',
      ctaUrl,
    }),
  }
}

/**
 * SMS variant of `collection_reminder`. Targets ≤160 GSM-7 chars.
 *
 * Example body for a typical short address:
 *   "Reminder: verge collection at 11A Loma St, Cottesloe on Wed 20 May.
 *    Items out by 7am. verco.au/b/COT-E88PNN"
 *   ≈ 130 chars (one segment).
 *
 * Long addresses can push past 160 — Twilio auto-segments at 160/153 chars
 * (each subsequent segment uses 7 chars for the multi-part header). Two
 * segments costs ~$0.14 instead of $0.07 — acceptable for an edge case.
 * If real-world addresses routinely overflow we'll truncate, but starting
 * with the natural form lets us see actual segment distribution from the
 * Twilio dashboard first.
 */
export function renderCollectionReminderSMS(
  booking: BookingForDispatch,
): RenderedSMS {
  const ref = booking.ref
  const dateStr = formatCollectionDateShort(booking.collection_date)
  // Strip the country part of the formatted address — the resident knows
  // they're in Australia. "11A Loma St, Cottesloe WA 6011, Australia" →
  // "11A Loma St, Cottesloe".
  const shortAddress = booking.address.split(',').slice(0, 2).join(',').trim()
  const link = buildSmsBookingLink(ref)
  return {
    body: `Reminder: verge collection at ${shortAddress} on ${dateStr}. Items out by 7am. ${link}`,
  }
}
