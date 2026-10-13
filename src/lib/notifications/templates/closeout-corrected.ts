import type { BookingForDispatch, RenderedEmail } from './types'
import { renderEmailLayout } from './_layout'
import { formatCollectionDate, escapeHtml, buildBookingPortalUrl } from './template-helpers'

/**
 * `closeout_corrected` template — sent when D&M office staff correct a crew's
 * closeout from Non-conformance / Nothing Presented to Completed (ADR 0030).
 *
 * Fires via:
 *   - `correctStopOutcome` server action (contractor-admin), after the
 *     `correct_stop_outcome` RPC withdraws the mistaken notice
 *
 * ## Content
 *
 *   Heading: "Update on your collection"
 *   Body:
 *     - The collection was completed; disregard the earlier notice
 *     - Details table: ref, service type, collection date, address
 *   CTA: "View booking" → tenant-host /booking/{ref} via buildBookingPortalUrl
 *
 * Corrections TO a notice outcome reuse ncn_raised / np_raised (with
 * `replaces_earlier_notice` on an NCN ↔ NP swap) — this template only covers
 * the "no notice after all" direction.
 *
 * ## Pure function
 *
 * Takes booking + appUrl + options, returns `{ subject, html }`. Kept in sync
 * with its Node/Deno mirror by the template-sync CI job.
 */

export interface RenderCloseoutCorrectedOptions {
  /** Booked service name(s) of the corrected collection (`stream` payload key). */
  serviceLabel?: string | undefined
}

export function renderCloseoutCorrected(
  booking: BookingForDispatch,
  appUrl: string,
  options: RenderCloseoutCorrectedOptions
): RenderedEmail {
  const ref = booking.ref
  const dateStr = formatCollectionDate(booking.collection_date)
  const address = booking.address

  const bodyHtml = `
    <p style="margin:0 0 16px 0">We've corrected the record of your verge collection: it was completed.</p>
    <p style="margin:0 0 16px 0">Please disregard the notice we sent you earlier about this collection. There's nothing you need to do.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse">
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Reference</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right;font-family:'SF Mono',monospace">${escapeHtml(ref)}</td></tr>
      ${options.serviceLabel ? `<tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Service type</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(options.serviceLabel)}</td></tr>` : ''}
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Collection date</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(dateStr)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap;vertical-align:top">Address</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(address)}</td></tr>
    </table>
    <p style="margin:0 0 16px 0">We're sorry for any confusion.</p>
  `

  const ctaUrl = buildBookingPortalUrl(
    booking.client,
    `/booking/${encodeURIComponent(ref)}`,
    appUrl,
  )

  return {
    subject: `Update on your collection — ${ref}`,
    html: renderEmailLayout({
      client: booking.client,
      preheader: `Your collection was completed — please disregard our earlier notice for booking ${ref}`,
      heading: 'Update on your collection',
      bodyHtml,
      ctaText: 'View booking',
      ctaUrl,
    }),
  }
}
