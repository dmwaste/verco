import type { BookingForDispatch, RenderedEmail } from './types.ts'
import { renderEmailLayout } from './_layout.ts'
import { formatCollectionDate, escapeHtml, buildBookingPortalUrl } from './template-helpers.ts'

/**
 * `np_raised` template — sent when a field user records a Nothing Presented notice.
 *
 * Fires via:
 *   - `raise-nothing-presented` server action (field role)
 *
 * ## Content
 *
 *   Heading: "Nothing presented"
 *   Body:
 *     - Intro copy — two variants:
 *         Standard (contractor_fault absent/false): "no items were found on the verge"
 *         Soft (contractor_fault = true): "unable to attend your address"
 *     - Optional notes block
 *     - Optional photo thumbnails (max 4)
 *     - Dispute window: resident has 14 days to dispute
 *     - Details table: ref, collection date, address
 *   CTA: "View booking" → tenant-host /booking/{ref} via buildBookingPortalUrl
 *
 * ## Pure function
 *
 * Takes booking + appUrl + options, returns `{ subject, html }`. Kept in sync
 * with its Node/Deno mirror by the template-sync CI job.
 */

export interface RenderNpRaisedOptions {
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

export function renderNpRaised(
  booking: BookingForDispatch,
  appUrl: string,
  options: RenderNpRaisedOptions
): RenderedEmail {
  const ref = booking.ref
  const dateStr = formatCollectionDate(booking.collection_date)
  const address = booking.address

  const introCopy = options.contractor_fault
    ? 'We were unable to attend your address as planned.'
    : 'Our crew attended your address but no items were found on the verge.'

  const notesBlock = options.notes
    ? `<p style="margin:0 0 16px 0;color:#293F52;font-size:14px"><strong>Notes:</strong> ${escapeHtml(options.notes)}</p>`
    : ''

  const visiblePhotos = (options.photos ?? []).slice(0, 4)
  const photosBlock =
    visiblePhotos.length > 0
      ? `<div style="margin:0 0 16px 0">${visiblePhotos.map((url) => `<img src="${escapeHtml(url)}" alt="Photo" style="max-width:100%;height:auto;border-radius:4px;margin:0 0 8px 0;display:block" />`).join('')}</div>`
      : ''

  const bodyHtml = `
    <p style="margin:0 0 16px 0">${introCopy}</p>
    ${notesBlock}
    ${photosBlock}
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

  return {
    subject: `Nothing presented — ${ref}`,
    html: renderEmailLayout({
      client: booking.client,
      preheader: `Nothing was presented for collection at your address for booking ${ref}`,
      heading: 'Nothing presented',
      bodyHtml,
      ctaText: 'View booking',
      ctaUrl,
    }),
  }
}
