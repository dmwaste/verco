import type { ClientBranding } from './types.ts'
import { escapeHtml } from './template-helpers.ts'

/**
 * Shared HTML email wrapper.
 *
 * Composes per-tenant branding (logo, primary colour, footer HTML) around a
 * caller-provided body. Pure function, no IO — fully unit-testable.
 *
 * Responsive: 600px max-width container (standard for transactional email)
 * with a media query collapsing to 100% on mobile. Uses table-based layout
 * for Outlook compatibility and inline styles for email-client support.
 *
 * Mirrored between Node and Deno — see `types.ts` header for the sync rules.
 *
 * ## Usage
 *
 *   renderEmailLayout({
 *     client,
 *     preheader: 'Your booking is confirmed',
 *     heading: 'Booking Confirmed',
 *     bodyHtml: '<p>Your verge collection is booked for ...</p>',
 *     ctaText: 'View booking',
 *     ctaUrl: 'https://verco.au/kwn/booking/VV-ABC123',
 *   })
 */

export interface RenderEmailLayoutParams {
  client: ClientBranding
  /** Hidden inbox preview text — shows in email client before the user opens */
  preheader: string
  /** Main H1 heading */
  heading: string
  /** Body content HTML — caller is responsible for escaping user input */
  bodyHtml: string
  /** Optional call-to-action button text — omit to render no button */
  ctaText?: string
  /** Optional CTA URL — omit (or pass without ctaText) to render no button */
  ctaUrl?: string
}

const DEFAULT_PRIMARY_COLOUR = '#293F52'
const DEFAULT_FOOTER_HTML =
  '<p style="margin:0;color:#8FA5B8;font-size:12px;line-height:1.5">You received this email because you booked a verge collection service.</p>'

/**
 * Normalise a hex colour value. Handles:
 *   - null / undefined → default
 *   - empty / whitespace → default
 *   - missing '#' prefix → prepended
 *   - otherwise → passed through
 */
function normaliseHex(colour: string | null): string {
  if (!colour) return DEFAULT_PRIMARY_COLOUR
  const trimmed = colour.trim()
  if (!trimmed) return DEFAULT_PRIMARY_COLOUR
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

export function renderEmailLayout(params: RenderEmailLayoutParams): string {
  const { client, preheader, heading, bodyHtml, ctaText, ctaUrl } = params
  const primary = normaliseHex(client.primary_colour)
  const footer = client.email_footer_html ?? DEFAULT_FOOTER_HTML
  const clientNameEscaped = escapeHtml(client.name)

  // The logo is the *light* (reversed) mark — invisible on the white email
  // header — so wrap it in a brand-colour box (the tenant primary colour) to
  // keep it visible. Table-based for Outlook; the text fallback below is
  // already dark-on-white and needs no box.
  const headerMarkup = client.logo_light_url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="background:${primary};border-radius:8px"><tr><td style="padding:12px 16px"><img src="${escapeHtml(client.logo_light_url)}" alt="${clientNameEscaped}" style="max-height:48px;height:auto;width:auto;display:block;border:0" /></td></tr></table>`
    : `<span style="font-size:20px;font-weight:bold;color:${primary};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${clientNameEscaped}</span>`

  const ctaMarkup =
    ctaText && ctaUrl
      ? `
            <tr>
              <td style="padding:24px 32px 8px 32px">
                <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${primary};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px">${escapeHtml(ctaText)}</a>
              </td>
            </tr>`
      : ''

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(heading)}</title>
    <style>
      body { margin: 0; padding: 0; background: #F8F9FA; }
      @media (max-width: 600px) {
        .container { width: 100% !important; max-width: 100% !important; }
        .container-cell { padding: 16px !important; }
      }
    </style>
  </head>
  <body>
    <span style="display:none !important;visibility:hidden;mso-hide:all;font-size:1px;color:#F8F9FA;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${escapeHtml(preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8F9FA">
      <tr>
        <td align="center" style="padding:32px 16px">
          <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#293F52">
            <tr>
              <td class="container-cell" style="padding:32px 32px 16px 32px;border-bottom:1px solid #F0F2F5">
                ${headerMarkup}
              </td>
            </tr>
            <tr>
              <td class="container-cell" style="padding:24px 32px 0 32px">
                <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:bold;color:${primary};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeHtml(heading)}</h1>
              </td>
            </tr>
            <tr>
              <td class="container-cell" style="padding:0 32px 0 32px;font-size:15px;line-height:1.6;color:#293F52">
                ${bodyHtml}
              </td>
            </tr>${ctaMarkup}
            <tr>
              <td class="container-cell" style="padding:32px 32px 24px 32px;border-top:1px solid #F0F2F5;margin-top:24px">
                ${footer}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}
