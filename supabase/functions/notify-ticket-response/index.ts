import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from '../_shared/database.types.ts'
import { isServiceRoleBearer } from '../_shared/service-role-auth.ts'
import { z } from 'https://esm.sh/zod@3.23.8'
import { jsonResponse, optionsResponse } from '../_shared/cors.ts'
import { sendEmail } from '../_shared/sendgrid.ts'
import { withSentry } from '../_shared/sentry.ts'
import { claimNotificationSend } from '../_shared/dispatch.ts'
import { notificationClaimStore } from '../_shared/notification-claim-store.ts'
import { renderTicketResponse, shouldNotifyResident } from '../_shared/templates/ticket-response.ts'
import { buildBookingPortalUrl } from '../_shared/templates/template-helpers.ts'
import type { ClientBranding } from '../_shared/templates/types.ts'

/**
 * notify-ticket-response Edge Function
 *
 * Emails the resident when a staff member posts a PUBLIC reply on their
 * service ticket. Called from the admin ticket UI with retries (see
 * src/lib/notifications/invoke-ticket-response.ts).
 *
 * Deliberately NOT routed through the booking-centric send-notification
 * dispatcher: a ticket needn't have a booking, and that EF's contract keys
 * on booking_id. This path renders a standalone template and logs to
 * notification_log with booking_id = the ticket's booking (may be NULL).
 *
 * Auth: service-role bearer (EF→EF) OR a staff user JWT. A user-JWT caller
 * is additionally tenant-checked against the ticket's client (accessible_
 * client_ids) — role alone is not tenant isolation (CLAUDE.md §4/§12).
 *
 * Idempotent per reply (#671): the send is claimed first (a `queued` row under
 * notification_log_send_claim_key, keyed on reference_id = the reply id), so
 * the admin page can retry and offer Resend without ever double-sending.
 *
 * Returns 200 on every non-catastrophic path (sent/failed/skipped/no_email;
 * skipped carries reason already_sent | in_flight | not_staff | internal_note)
 * so the caller can tell staff what happened; 401 auth, 400 bad input,
 * 403 tenant mismatch, 404 missing row, 500 only on crash.
 */

const RequestSchema = z.object({ ticket_response_id: z.string().uuid() })

// Duplicated from the admin ticket UI (Deno can't import the client component).
// Six static strings — a shared module would be over-abstraction.
const CATEGORY_LABELS: Record<string, string> = {
  general: 'General',
  booking: 'Booking Enquiry',
  billing: 'Billing',
  service: 'Service Issue',
  complaint: 'Complaint',
  other: 'Other',
}

// Only staff who can act on tickets may trigger a resident-facing send.
// Never field/ranger (PII red line) or resident.
const PERMITTED_ROLES = new Set([
  'contractor-admin',
  'contractor-staff',
  'client-admin',
  'client-staff',
])

serve(withSentry('notify-ticket-response', async (req) => {
  const start = Date.now()

  if (req.method === 'OPTIONS') return optionsResponse()
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  // ── Auth: service-role bearer OR staff user JWT ──────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized — missing bearer token' }, 401)
  }
  const token = authHeader.slice('Bearer '.length)
  // Any valid service-role secret for this project (legacy JWT or sb_secret_),
  // not only the one injected in env (#480). An empty bearer never matches.
  const isServiceRole = await isServiceRoleBearer(token, {
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  })
  if (!isServiceRole) {
    const supabaseAnon = createClient<Database>(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: role, error: roleError } = await supabaseAnon.rpc('current_user_role')
    if (roleError || !role || !PERMITTED_ROLES.has(role as string)) {
      return jsonResponse({ error: 'Unauthorized — staff role required' }, 401)
    }
  }

  // ── Parse + validate ─────────────────────────────────────────────────────
  let body: unknown
  try {
    body = await req.json()
  } catch (err) {
    return jsonResponse({ error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }, 400)
  }
  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) return jsonResponse({ error: parsed.error.message }, 400)
  const { ticket_response_id } = parsed.data

  const log = (extras: Record<string, unknown>) =>
    console.log(JSON.stringify({
      event: 'ticket_notification_dispatch',
      ticket_response_id,
      duration_ms: Date.now() - start,
      ...extras,
    }))

  const supabase = createClient<Database>(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  // Set once this request holds the reply's send claim, cleared once settled.
  let openClaimId: string | null = null

  try {
    // 1. Load the response row.
    const { data: response, error: respErr } = await supabase
      .from('ticket_response')
      .select('id, ticket_id, author_type, is_internal, message')
      .eq('id', ticket_response_id)
      .single()
    if (respErr || !response) {
      log({ status: 'error', error: 'response_not_found' })
      return jsonResponse({ status: 'error', error: 'Ticket response not found' }, 404)
    }

    // 2. Guard — only public staff replies notify. No-op (200) otherwise.
    if (!shouldNotifyResident(response.author_type, response.is_internal)) {
      const reason = response.author_type !== 'staff' ? 'not_staff' : 'internal_note'
      log({ status: 'skipped', reason })
      return jsonResponse({ status: 'skipped', reason })
    }

    // 3. Load the ticket.
    const { data: ticket, error: ticketErr } = await supabase
      .from('service_ticket')
      .select('id, display_id, subject, category, client_id, contact_id, booking_id')
      .eq('id', response.ticket_id)
      .single()
    if (ticketErr || !ticket) {
      log({ status: 'error', error: 'ticket_not_found' })
      return jsonResponse({ status: 'error', error: 'Ticket not found' }, 404)
    }

    // 3b. TENANT GUARD (review finding F2 — cross-tenant IDOR).
    // Role alone is NOT tenant isolation (CLAUDE.md §4/§12). All reads above
    // use service role and bypass RLS, so this is the ONLY tenant boundary in
    // the EF. A client-tier staffer for council A must not trigger a send on
    // council B's ticket. Service-role callers (EF→EF) are trusted and skip.
    // The `ticket_response_id` is caller-supplied, so this must run for every
    // user-JWT caller before we render or send anything.
    if (!isServiceRole) {
      const supabaseCaller = createClient<Database>(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } },
      )
      // accessible_client_ids() is SETOF uuid → supabase-js returns string[].
      const { data: allowed, error: allowedErr } = await supabaseCaller.rpc('accessible_client_ids')
      const allowedIds = (allowed ?? []) as string[]
      if (allowedErr || !allowedIds.includes(ticket.client_id)) {
        log({ status: 'skipped', reason: 'tenant_mismatch' })
        return jsonResponse({ status: 'skipped', reason: 'tenant_mismatch' }, 403)
      }
    }

    // 5. Load the resident contact.
    const { data: contact, error: contactErr } = await supabase
      .from('contacts')
      .select('id, full_name, email')
      .eq('id', ticket.contact_id)
      .single()
    if (contactErr || !contact) {
      log({ status: 'error', error: 'contact_not_found' })
      return jsonResponse({ status: 'error', error: 'Contact not found' }, 404)
    }

    // 6. Load client branding.
    const { data: client, error: clientErr } = await supabase
      .from('client')
      .select('name, logo_light_url, primary_colour, email_footer_html, slug, custom_domain, reply_to_email, email_from_name')
      .eq('id', ticket.client_id)
      .single()
    if (clientErr || !client) {
      log({ status: 'error', error: 'client_not_found' })
      return jsonResponse({ status: 'error', error: 'Client not found' }, 404)
    }

    const appUrl = Deno.env.get('APP_URL') ?? 'https://verco.au'
    const defaultFrom = Deno.env.get('DEFAULT_FROM_EMAIL') ?? 'noreply@verco.au'

    // 7. Claim the send (#671): this reply's log row goes in as `queued` under
    //    notification_log_send_claim_key BEFORE we send, so a retried or
    //    resent invoke (the admin page retries gateway failures and offers a
    //    Resend button) can never email the resident twice. Replaces the old
    //    "is there a sent row?" check, which couldn't see a send in flight.
    const logRow = {
      booking_id: ticket.booking_id,
      contact_id: contact.id,
      client_id: ticket.client_id,
      channel: 'email',
      notification_type: 'ticket_response',
      reference_id: ticket_response_id,
      to_address: contact.email || 'unknown',
    }
    const claim = await claimNotificationSend(notificationClaimStore(supabase), logRow)
    if (claim.outcome === 'held') {
      const reason = claim.by === 'sent' ? 'already_sent' : 'in_flight'
      log({ status: 'skipped', reason })
      return jsonResponse({ status: 'skipped', reason })
    }
    if (claim.outcome === 'error') {
      // Never a new way to lose a reply: send unclaimed, log the old way.
      console.error(`notify-ticket-response: send claim failed (${claim.error}) — sending unclaimed`)
    }
    openClaimId = claim.outcome === 'claimed' ? claim.id : null

    // Record this attempt's outcome on the claim row (or, unclaimed, a new row).
    const settle = async (status: 'sent' | 'failed', errorMessage: string | null) => {
      const id = openClaimId
      openClaimId = null
      const { error } = id
        ? await supabase.from('notification_log').update({ status, error_message: errorMessage }).eq('id', id)
        : await supabase.from('notification_log').insert({ ...logRow, status, error_message: errorMessage })
      if (error) console.error(`notify-ticket-response: notification_log write failed: ${error.message}`)
    }

    // No email → the attempt is a failed row (nullable booking_id), return no_email.
    if (!contact.email) {
      await settle('failed', 'Contact has no email')
      log({ status: 'no_email' })
      return jsonResponse({ status: 'no_email' })
    }

    // 8. Build the tenant-host ticket URL + render.
    const ticketUrl = buildBookingPortalUrl(
      { slug: client.slug, custom_domain: client.custom_domain },
      `/contact/tickets/${encodeURIComponent(ticket.display_id)}`,
      appUrl,
    )
    const branding: ClientBranding = {
      name: client.name,
      logo_light_url: client.logo_light_url,
      primary_colour: client.primary_colour,
      email_footer_html: client.email_footer_html,
    }
    const { subject, html } = renderTicketResponse({
      client: branding,
      ticketDisplayId: ticket.display_id,
      ticketSubject: ticket.subject,
      categoryLabel: CATEGORY_LABELS[ticket.category] ?? ticket.category,
      replyMessage: response.message,
      ticketUrl,
    })

    // 9. Send.
    const sendResult = await sendEmail({
      to: { email: contact.email, name: contact.full_name },
      from: {
        email: client.reply_to_email ?? defaultFrom,
        name: client.email_from_name ?? client.name,
      },
      subject,
      htmlBody: html,
    })

    // 10. Settle the claim row (booking_id may be NULL).
    await settle(sendResult.ok ? 'sent' : 'failed', sendResult.ok ? null : (sendResult.error ?? 'SendGrid send failed'))

    log({ status: sendResult.ok ? 'sent' : 'failed', ...(sendResult.ok ? {} : { error: sendResult.error }) })
    return jsonResponse({
      status: sendResult.ok ? 'sent' : 'failed',
      ...(sendResult.ok ? {} : { error: sendResult.error }),
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    // Don't strand our claim as `queued` (it would block a Resend for 10 min).
    if (openClaimId) {
      await supabase
        .from('notification_log')
        .update({ status: 'failed', error_message: `crashed: ${error}` })
        .eq('id', openClaimId)
        .then(({ error: e }) => e && console.error(`notify-ticket-response: could not settle claim: ${e.message}`))
    }
    log({ status: 'error', error: `crashed: ${error}` })
    return jsonResponse({ status: 'error', error }, 500)
  }
}))
