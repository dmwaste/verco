import type { BookingForDispatch, RenderedEmail } from './types.ts'
import { renderEmailLayout } from './_layout.ts'
import { formatCollectionDate, escapeHtml, buildBookingPortalUrl } from './template-helpers.ts'

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
   * Waste-stream label (e.g. "Green") when the notice was raised against a
   * single per-stream collection stop. Bookings with multiple streams are
   * collected in separate passes — naming the stream tells the resident
   * which part of their collection this notice covers.
   */
  stream?: string | undefined
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

  const visiblePhotos = (options.photos ?? []).slice(0, 4)
  const photosBlock =
    visiblePhotos.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0">${visiblePhotos.map((url) => `<tr><td style="padding:0 0 8px 0"><a href="${escapeHtml(url)}" style="display:block;overflow:hidden;border-radius:4px;background:#F8F9FA url(${escapeHtml(url)}) center/cover no-repeat;height:160px;max-width:100%"> </a></td></tr>`).join('')}</table>`
      : ''

  const bodyHtml = `
    <p style="margin:0 0 16px 0">${introCopy}</p>
    ${reasonBlock}
    ${notesBlock}
    ${photosBlock}
    <p style="margin:0 0 16px 0;color:#8FA5B8;font-size:13px">You have 14 days from the date of this notice to dispute it.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse">
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Reference</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right;font-family:'SF Mono',monospace">${escapeHtml(ref)}</td></tr>
      ${options.stream ? `<tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Collection</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(options.stream)}</td></tr>` : ''}
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
