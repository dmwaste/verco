import type { ClientBranding, RenderedEmail } from './types'
import { renderEmailLayout } from './_layout'
import { escapeHtml } from './template-helpers'

/**
 * `ticket_response` template — sent to the resident when a staff member posts
 * a public reply on their service ticket.
 *
 * ## Content
 *   Heading: "New reply to your enquiry"
 *   Body:
 *     - Intro naming the client team
 *     - The staff reply (HTML-escaped, newlines → <br>)
 *     - Details block: reference (display_id), subject, category
 *   CTA: "View & reply" → tenant-host /contact/tickets/{display_id}
 *
 * ## Pure function
 * Takes a self-contained data object (decoupled from BookingForDispatch — a
 * ticket needn't have a booking), returns `{ subject, html }`. Mirrored to
 * `src/lib/notifications/templates/ticket-response.ts` by scripts/sync-mirrors.sh.
 */

export interface TicketResponseEmailData {
  client: ClientBranding
  ticketDisplayId: string
  ticketSubject: string
  categoryLabel: string
  replyMessage: string
  /** Absolute tenant-host URL to the resident's ticket, built by the caller. */
  ticketUrl: string
}

export function renderTicketResponse(data: TicketResponseEmailData): RenderedEmail {
  const messageHtml = escapeHtml(data.replyMessage).replace(/\n/g, '<br>')
  const clientName = escapeHtml(data.client.name)

  const bodyHtml = `
    <p style="margin:0 0 16px 0;color:#293F52;font-size:14px">A member of the ${clientName} team has replied to your enquiry.</p>
    <div style="margin:0 0 16px 0;padding:12px 16px;background:#F8F9FA;border-left:3px solid #8FA5B8;color:#293F52;font-size:14px;line-height:1.5">${messageHtml}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse">
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Reference</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right;font-family:'SF Mono',monospace">${escapeHtml(data.ticketDisplayId)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap;vertical-align:top">Subject</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(data.ticketSubject)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#8FA5B8;font-size:13px;white-space:nowrap">Category</td><td style="padding:6px 0;color:#293F52;font-size:13px;text-align:right">${escapeHtml(data.categoryLabel)}</td></tr>
    </table>
    <p style="margin:0 0 16px 0;color:#8FA5B8;font-size:13px">Use the button below to view the full conversation and reply.</p>
  `

  return {
    subject: `New reply to your enquiry [${data.ticketDisplayId}]`,
    html: renderEmailLayout({
      client: data.client,
      preheader: `${data.client.name} replied to your enquiry ${data.ticketDisplayId}`,
      heading: 'New reply to your enquiry',
      bodyHtml,
      ctaText: 'View & reply',
      ctaUrl: data.ticketUrl,
    }),
  }
}

/**
 * Pure gate for whether a ticket_response should notify the resident.
 * Only PUBLIC replies authored by staff notify — resident replies and
 * internal staff notes never do. Co-located with the template so it is
 * mirrored to Node and unit-testable (the EF runtime is Deno).
 */
export function shouldNotifyResident(authorType: string, isInternal: boolean): boolean {
  return authorType === 'staff' && !isInternal
}
