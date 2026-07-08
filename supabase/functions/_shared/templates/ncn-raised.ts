import type { BookingForDispatch, RenderedEmail } from './types.ts'
import { renderEmailLayout } from './_layout.ts'
import { formatCollectionDate, escapeHtml, buildBookingPortalUrl, renderPhotoBlock } from './template-helpers.ts'

/**
 * `ncn_raised` template — sent when a field user raises a non-conformance
 * notice (NCN) against a booking.
 *
 * ## Content
 *
 *   Heading: "Non-conformance notice"
 *   Body:
 *     - Intro copy (softer if contractor_fault is true)
 *     - Reason block (highlighted, HTML-escaped)
 *     - Optional notes
 *     - Optional photo thumbnails (max 4)
 *     - City of Kwinana compliance directive (kwn slug, resident-fault only)
 *     - Dispute window notice (14 days)
 *     - Details table: ref, collection date, address
 *   CTA: "View booking" → tenant-host /booking/{ref} via buildBookingPortalUrl
 *
 * ## Pure function
 *
 * Takes booking + appUrl + options, returns `{ subject, html }`. Mirrored to
 * `supabase/functions/_shared/templates/ncn-raised.ts` — kept in sync by the
 * template-sync CI job.
 */

export interface RenderNcnRaisedOptions {
  reason: string
  notes?: string | undefined
  photos?: string[] | undefined
  contractor_fault?: boolean | undefined
  /**
   * Booked service name(s) this notice covers, e.g. "E-Waste, Mattress" or
   * "Bulk Waste" — residents book by service, not internal stream, and a
   * booking's streams are collected in separate passes, so naming the
   * service(s) tells the resident exactly which collection this is about.
   * The dispatcher maps the `stream` payload key onto this at the boundary.
   */
  serviceLabel?: string | undefined
}

export function renderNcnRaised(
  booking: BookingForDispatch,
  appUrl: string,
  options: RenderNcnRaisedOptions
): RenderedEmail {
  const ref = booking.ref
  const dateStr = formatCollectionDate(booking.collection_date)
  const address = booking.address

  const introCopy = options.contractor_fault
    ? 'We were unable to complete your collection as planned. Please see the details below.'
    : 'A non-conformance notice has been issued for your verge collection booking.'

  const reasonBlock = `<p style="margin:0 0 16px 0;padding:12px 16px;background:#F8F9FA;border-left:3px solid #8FA5B8;color:#293F52;font-size:14px"><strong>Reason:</strong> ${escapeHtml(options.reason)}</p>`

  const notesBlock = options.notes
    ? `<p style="margin:0 0 16px 0;color:#293F52;font-size:14px"><strong>Notes:</strong> ${escapeHtml(options.notes)}</p>`
    : ''

  const photosBlock = renderPhotoBlock(options.photos)

  // City of Kwinana attaches a statutory compliance directive to its
  // non-conformance notices (Waste Local Law 2022 s2.10(1)). Only the resident
  // sees an infringement warning — suppressed when contractor_fault is true,
  // because we don't threaten a fine when D&M was unable to complete the
  // collection. Every other tenant renders no extra block (empty string).
  // Static council-authored copy — no user input, so no escaping needed.
  const kwnComplianceBlock =
    booking.client.slug === 'kwn' && !options.contractor_fault
      ? `
    <p style="margin:0 0 16px 0;color:#293F52;font-size:14px">Please remove all remaining items from your verge and place them behind your property line or dispose of them at a licensed waste disposal facility within 7 days of this notice. Failure to comply with this request may result in a $400 infringement under section 2.10(1) of the City of Kwinana Waste Local Law 2022.</p>
    <p style="margin:0 0 16px 0;color:#293F52;font-size:14px">If you have made multiple bookings, it's possible to receive this notification if certain waste from one collection wasn't placed out, since different trucks pick up bulk waste, green waste, metal, e-waste, and mattresses separately. If you have a second booking, please keep your waste on the verge until both collections are complete.</p>
    <p style="margin:0 0 16px 0;color:#293F52;font-size:14px">If your items are compliant but you did not book adequate collections, or if an incorrect collection type was selected, you can arrange an additional collection at <a href="https://kwn.verco.au" style="color:#293F52;text-decoration:underline">kwn.verco.au</a>.</p>
    <p style="margin:0 0 16px 0;color:#293F52;font-size:14px">If you have any questions or concerns, please visit <a href="https://www.kwinana.wa.gov.au/verge" style="color:#293F52;text-decoration:underline">www.kwinana.wa.gov.au/verge</a> or lodge an online inquiry at <a href="https://kwn.verco.au/contact" style="color:#293F52;text-decoration:underline">kwn.verco.au/contact</a>.</p>
    <p style="margin:0 0 16px 0;color:#293F52;font-size:14px">Thank you for your cooperation.</p>
    <p style="margin:0 0 16px 0;color:#293F52;font-size:14px;line-height:1.5"><strong>Emma Gillham</strong><br />Waste Management Officer<br />City of Kwinana</p>`
      : ''

  const bodyHtml = `
    <p style="margin:0 0 16px 0">${introCopy}</p>
    ${reasonBlock}
    ${notesBlock}
    ${photosBlock}
    ${kwnComplianceBlock}
    <p style="margin:0 0 16px 0;color:#8FA5B8;font-size:13px">You have 14 days from the date of this notice to dispute it.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse">
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Reference</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right;font-family:'SF Mono',monospace">${escapeHtml(ref)}</td></tr>
      ${options.serviceLabel ? `<tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Service type</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(options.serviceLabel)}</td></tr>` : ''}
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Collection date</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(dateStr)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap;vertical-align:top">Address</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(address)}</td></tr>
    </table>
  `

  const ctaUrl = buildBookingPortalUrl(
    booking.client,
    `/booking/${encodeURIComponent(ref)}`,
    appUrl,
  )
  const preheader = options.contractor_fault
    ? `We were unable to complete your collection for booking ${ref}`
    : `A non-conformance notice has been issued for booking ${ref}`

  return {
    subject: `Non-conformance notice — ${ref}`,
    html: renderEmailLayout({
      client: booking.client,
      preheader,
      heading: 'Non-conformance notice',
      bodyHtml,
      ctaText: 'View booking',
      ctaUrl,
    }),
  }
}
