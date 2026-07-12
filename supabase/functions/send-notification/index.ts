import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { dispatch } from '../_shared/dispatch.ts'
import type {
  BookingForDispatch,
  DispatchDeps,
  NotificationChannel,
  NotificationDispatchInput,
  NotificationLogRow,
  NotificationType,
  SendEmailParams,
  SendEmailResult,
  SendSMSParams,
  SendSMSResult,
} from '../_shared/dispatch.ts'
import { sendEmail as sendgridSendEmail } from '../_shared/sendgrid.ts'
import { sendSMS as twilioSendSMS } from '../_shared/twilio.ts'

/**
 * send-notification Edge Function
 *
 * The single entry point for all transactional email in Verco.
 *
 * ## Contract
 *
 *   POST /functions/v1/send-notification
 *   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 *   Content-Type: application/json
 *   Body: NotificationDispatchInput (see _shared/templates/types.ts)
 *
 *   Returns: DispatchResult as JSON (200 in all success cases including
 *   skipped and failed; 400 on malformed input; 401 on auth failure; 5xx
 *   only on catastrophic runtime errors)
 *
 * ## Auth modes
 *
 * The EF accepts two bearer-token modes:
 *
 *   1. **Service role** — used by EF→EF callers (create-booking, stripe-
 *      webhook, handle-expired-payments). These pass
 *      `SUPABASE_SERVICE_ROLE_KEY` directly.
 *   2. **Valid user JWT with a permitted role** — used by server-action→EF
 *      callers (admin cancel, resident cancel, field NCN/NP raise).
 *      Per CLAUDE.md §20 Red Line #3, the service role key must NOT appear
 *      in app/ code. Server actions pass the user's session access token
 *      and this EF validates that the user's role is in the permitted set
 *      before proceeding.
 *
 * Regardless of auth mode, the **actual dispatcher work happens with
 * service role** — contact/client loads need to bypass RLS. The user's
 * role gates the TRIGGER, not the underlying data access.
 *
 * Permitted user roles: contractor-admin, contractor-staff, client-admin,
 * client-staff, field, ranger, resident. Resident callers are server
 * actions (e.g. resident cancel) that pass the user's own JWT.
 *
 * ## Fire-and-forget discipline
 *
 * Even on failure, this EF returns 200 with `{ ok: false, error: ... }` —
 * the caller has already committed its primary operation and must not be
 * broken by a notification failure. Only truly catastrophic crashes return
 * 5xx (caught at the outer try/catch).
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  // ── Auth: service role bearer OR user JWT with permitted role ─────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized — missing bearer token' }, 401)
  }
  const token = authHeader.slice('Bearer '.length)
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const isServiceRole = token === serviceRoleKey

  const PERMITTED_USER_ROLES = new Set([
    'contractor-admin',
    'contractor-staff',
    'client-admin',
    'client-staff',
    'field',
    'ranger',
    'resident',
  ])

  if (!isServiceRole) {
    // Validate the user JWT by calling current_user_role() via an
    // authed anon client — if the JWT is invalid the call fails.
    const supabaseAnon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: role, error: roleError } = await supabaseAnon.rpc(
      'current_user_role'
    )
    if (roleError || !role || !PERMITTED_USER_ROLES.has(role as string)) {
      return jsonResponse(
        {
          error:
            'Unauthorized — service role or valid user JWT with permitted role required',
        },
        401
      )
    }
  }

  // ── Parse body ─────────────────────────────────────────────────────────
  let input: NotificationDispatchInput
  try {
    input = (await req.json()) as NotificationDispatchInput
  } catch (err) {
    return jsonResponse(
      { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` },
      400
    )
  }

  // Minimal shape validation — the dispatcher will handle the detailed
  // branching between NotificationPayload and NotificationResumePayload.
  if (!input || typeof input !== 'object') {
    return jsonResponse({ ok: false, error: 'Payload must be a JSON object' }, 400)
  }
  if (
    !('notification_log_id' in input) &&
    !('type' in input && 'booking_id' in input)
  ) {
    return jsonResponse(
      { ok: false, error: 'Payload must include either {type, booking_id} or {notification_log_id}' },
      400
    )
  }

  // ── Build service-role Supabase client ─────────────────────────────────
  const supabaseService = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // ── Wire up DispatchDeps with real implementations ─────────────────────
  const deps: DispatchDeps = {
    loadBooking: async (booking_id: string): Promise<BookingForDispatch | null> => {
      const { data, error } = await supabaseService
        .from('booking')
        .select(
          `
          id, ref, type, client_id,
          contact:contact_id ( id, full_name, email, mobile_e164 ),
          client:client_id (
            slug, custom_domain, name, logo_light_url, primary_colour,
            email_footer_html, reply_to_email, email_from_name,
            twilio_messaging_service_sid
          ),
          eligible_properties:property_id ( address, formatted_address ),
          booking_item (
            no_services, is_extra, unit_price_cents,
            service:service_id ( name ),
            collection_date:collection_date_id ( date )
          )
          `
        )
        .eq('id', booking_id)
        .maybeSingle()

      if (error || !data) {
        return null
      }

      // Supabase nested selects return an object OR a single-element array
      // depending on the relationship shape — normalise to object.
      const pickOne = <T>(v: T | T[] | null): T | null =>
        v === null ? null : Array.isArray(v) ? (v[0] ?? null) : v

      const contact = pickOne(
        data.contact as
          | { id: string; full_name: string; email: string; mobile_e164: string | null }
          | { id: string; full_name: string; email: string; mobile_e164: string | null }[]
          | null
      )
      type LoadedClient = {
        slug: string
        custom_domain: string | null
        name: string
        logo_light_url: string | null
        primary_colour: string | null
        email_footer_html: string | null
        reply_to_email: string | null
        email_from_name: string | null
        twilio_messaging_service_sid: string | null
      }
      const client = pickOne(
        data.client as LoadedClient | LoadedClient[] | null
      )
      const property = pickOne(
        data.eligible_properties as
          | { address: string; formatted_address: string | null }
          | { address: string; formatted_address: string | null }[]
          | null
      )

      if (!client) {
        return null
      }

      const items = ((data.booking_item as unknown as Array<{
        no_services: number
        is_extra: boolean
        unit_price_cents: number
        service: { name: string } | { name: string }[] | null
        collection_date: { date: string } | { date: string }[] | null
      }> | null) ?? []).map((bi) => {
        const svc = pickOne(bi.service)
        return {
          service_name: svc?.name ?? '(unknown service)',
          no_services: bi.no_services,
          is_extra: bi.is_extra,
          line_charge_cents: bi.is_extra ? bi.unit_price_cents * bi.no_services : 0,
        }
      })

      // Collection date — all booking_items for a single booking share the
      // same collection_date in v1, so take the first.
      const firstItemRaw = ((data.booking_item as unknown as Array<{
        collection_date: { date: string } | { date: string }[] | null
      }> | null) ?? [])[0]
      const firstItemDate = firstItemRaw
        ? pickOne(firstItemRaw.collection_date)
        : null
      const collection_date = firstItemDate?.date ?? ''

      const total_charge_cents = items.reduce(
        (sum, it) => sum + it.line_charge_cents,
        0
      )

      return {
        id: data.id as string,
        ref: data.ref as string,
        type: data.type as string,
        client_id: data.client_id as string,
        address: property?.formatted_address ?? property?.address ?? '',
        collection_date,
        total_charge_cents,
        items,
        client: {
          name: client.name,
          logo_light_url: client.logo_light_url,
          primary_colour: client.primary_colour,
          email_footer_html: client.email_footer_html,
          slug: client.slug,
          custom_domain: client.custom_domain,
          reply_to_email: client.reply_to_email,
          email_from_name: client.email_from_name,
          twilio_messaging_service_sid: client.twilio_messaging_service_sid,
        },
        contact: contact
          ? {
              id: contact.id,
              full_name: contact.full_name,
              email: contact.email,
              mobile_e164: contact.mobile_e164,
            }
          : null,
      }
    },

    isAlreadySent: async (
      booking_id: string,
      type: NotificationType,
      channel: NotificationChannel,
      referenceId?: string | null,
    ): Promise<boolean> => {
      // Per-notice key when a reference id is supplied (ncn_id / np_id) —
      // the stop model raises one notice per waste stream, so a booking can
      // legitimately have several same-type sends.
      let query = supabaseService
        .from('notification_log')
        .select('id')
        .eq('booking_id', booking_id)
        .eq('notification_type', type)
        .eq('channel', channel)
        .eq('status', 'sent')
      if (referenceId) query = query.eq('reference_id', referenceId)
      const { data } = await query.limit(1)
      return Array.isArray(data) && data.length > 0
    },

    writeLog: async (row: NotificationLogRow): Promise<string | null> => {
      const { data, error } = await supabaseService
        .from('notification_log')
        .insert({
          booking_id: row.booking_id,
          contact_id: row.contact_id,
          client_id: row.client_id,
          channel: row.channel,
          notification_type: row.notification_type,
          to_address: row.to_address,
          status: row.status,
          error_message: row.error_message ?? null,
          reference_id: row.reference_id ?? null,
        })
        .select('id')
        .single()
      if (error || !data) {
        console.error('writeLog failed:', error?.message)
        return null
      }
      return data.id as string
    },

    loadNotificationLog: async (id: string) => {
      const { data, error } = await supabaseService
        .from('notification_log')
        .select('booking_id, notification_type, status, to_address')
        .eq('id', id)
        .maybeSingle()
      if (error || !data) return null
      return {
        booking_id: data.booking_id as string,
        notification_type: data.notification_type as NotificationType,
        status: data.status as 'queued' | 'sent' | 'failed',
        to_address: data.to_address as string,
      }
    },

    updateLogStatus: async (
      id: string,
      status: 'sent' | 'failed',
      errorMessage?: string,
      toAddress?: string
    ) => {
      const updateData: Record<string, unknown> = { status }
      if (errorMessage !== undefined) updateData.error_message = errorMessage
      if (toAddress !== undefined) updateData.to_address = toAddress
      const { error } = await supabaseService
        .from('notification_log')
        .update(updateData)
        .eq('id', id)
      if (error) {
        console.error('updateLogStatus failed:', error.message)
      }
    },

    sendEmail: async (params: SendEmailParams): Promise<SendEmailResult> => {
      const result = await sendgridSendEmail({
        to: { email: params.to.email, name: params.to.name },
        from: { email: params.from.email, name: params.from.name },
        subject: params.subject,
        htmlBody: params.htmlBody,
      })
      if (result.ok) return { ok: true }
      return { ok: false, error: result.error ?? 'Unknown SendGrid error' }
    },

    sendSMS: async (params: SendSMSParams): Promise<SendSMSResult> => {
      const result = await twilioSendSMS({
        to: params.to,
        body: params.body,
        messagingServiceSid: params.messagingServiceSid,
      })
      if (result.ok) {
        return { ok: true, messageSid: result.messageSid }
      }
      return { ok: false, error: result.error ?? 'Unknown Twilio error' }
    },

    loadRefundAmountCents: async (
      refundRequestId: string,
      bookingId: string,
    ): Promise<number | null> => {
      const { data, error } = await supabaseService
        .from('refund_request')
        .select('amount_cents, booking_id')
        .eq('id', refundRequestId)
        .maybeSingle()
      // Fail safe: no row, load error, or a row that belongs to a DIFFERENT
      // booking → no refund line (never surface another booking's amount).
      if (error || !data || data.booking_id !== bookingId) return null
      return data.amount_cents as number
    },

    appUrl: Deno.env.get('APP_URL') ?? 'https://verco.au',
    defaultFromEmail: Deno.env.get('DEFAULT_FROM_EMAIL') ?? 'noreply@verco.au',
  }

  try {
    const result = await dispatch(deps, input)
    return jsonResponse(result, 200)
  } catch (err) {
    // Outer guard — dispatch should never throw, but if it does we return
    // 500 so the caller's structured logging captures the crash.
    console.error(
      JSON.stringify({
        event: 'notification_dispatch',
        status: 'failed',
        error: `uncaught: ${err instanceof Error ? err.message : String(err)}`,
      })
    )
    return jsonResponse(
      { ok: false, error: `Uncaught: ${err instanceof Error ? err.message : String(err)}` },
      500
    )
  }
})
