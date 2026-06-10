/**
 * Notification payload types and dispatcher contract.
 *
 * All notifications flow through a single `send-notification` Edge Function
 * that accepts a discriminated union payload, resolves booking + contact +
 * client server-side (with service role — field callers never touch PII),
 * renders the appropriate template via `_layout.ts`, and logs the attempt
 * to `notification_log`.
 *
 * Mirrored between Node (`src/lib/notifications/templates/types.ts`) and
 * Deno (`supabase/functions/_shared/templates/types.ts`). CI guard enforces
 * that the two stay in sync — see `.github/workflows/ci.yml` → template-sync.
 *
 * ## Structured logging contract
 *
 * Every dispatcher attempt MUST emit exactly one JSON line to stdout:
 *
 *   console.log(JSON.stringify({
 *     event: 'notification_dispatch',
 *     booking_id: string,
 *     type: NotificationType,
 *     duration_ms: number,
 *     sendgrid_status: number | null,  // HTTP status from SendGrid, null if never reached
 *     status: 'sent' | 'failed' | 'skipped',
 *     error?: string,                   // only set when status = 'failed'
 *   }))
 *
 * Supabase log drain picks this up for downstream analysis. Do NOT log
 * contact PII fields — the whole point of the single-dispatcher architecture
 * is that PII stays inside the dispatcher, never in stdout.
 *
 * ## notification_log.status invariants
 *
 * Enforced by CHECK constraint at the DB level (see migration
 * `20260409000000_notification_log_status_check.sql`):
 *
 *   - 'queued'  — row created, not yet sent. Used by Phase 4 24h expiry
 *                 flow (write queued → update booking → dispatch by log_id)
 *                 and Phase 5 admin retry flow.
 *   - 'sent'    — sendEmail returned 2xx, row is terminal.
 *   - 'failed'  — sendEmail returned error OR dispatcher crashed mid-flight,
 *                 row is terminal for this attempt. Admin can manually retry
 *                 within 7 days via /admin/notifications.
 *
 * Idempotency key: `(booking_id, notification_type)` where `status = 'sent'`.
 * A prior `failed` row does not block a retry; a prior `sent` row does.
 */

export type NotificationType =
  | 'booking_created'
  | 'booking_cancelled'
  | 'payment_reminder'
  | 'payment_expired'
  | 'ncn_raised'
  | 'np_raised'
  | 'completion_survey'
  | 'collection_reminder'

/**
 * Per-channel dispatch. notification_log idempotency keys on
 * (booking_id, notification_type, channel) — sending the email does NOT
 * block the SMS for the same notification.
 */
export type NotificationChannel = 'email' | 'sms'

export type NotificationLogStatus = 'queued' | 'sent' | 'failed'

/**
 * The primary dispatcher input — a discriminated union keyed by `type`.
 * Most callers (EFs and server actions) use this shape.
 */
export type NotificationPayload =
  | { type: 'booking_created'; booking_id: string }
  | { type: 'booking_cancelled'; booking_id: string; reason?: string; refund_status?: 'processed' | 'pending_review' }
  | { type: 'payment_reminder'; booking_id: string }
  | { type: 'payment_expired'; booking_id: string }
  | { type: 'ncn_raised'; booking_id: string; ncn_id: string; reason: string; notes?: string; photos?: string[]; contractor_fault?: boolean; stream?: string }
  | { type: 'np_raised'; booking_id: string; np_id: string; notes?: string; photos?: string[]; contractor_fault?: boolean; stream?: string }
  | { type: 'completion_survey'; booking_id: string; survey_token: string }
  | { type: 'collection_reminder'; booking_id: string }

/**
 * Alternative input for the "resume a pre-existing queued row" path.
 *
 * Used by:
 *   - Phase 4 handle-expired-payments EF — writes a queued log row inside
 *     the same transaction as the booking status UPDATE, then invokes the
 *     dispatcher by log_id. This guarantees at-least-once delivery even if
 *     the send crashes after the status flip.
 *   - Phase 5 admin retry action — sets an existing failed row back to
 *     queued inside a SELECT FOR UPDATE lock, then invokes by log_id.
 */
export interface NotificationResumePayload {
  notification_log_id: string
}

export type NotificationDispatchInput =
  | NotificationPayload
  | NotificationResumePayload

/**
 * Dispatcher result. Never throws across the EF boundary — all failure
 * modes are encoded in the return value so callers can fire-and-forget
 * without breaking their own operation.
 */
export type DispatchResult =
  | { ok: true; skipped: true }
  | { ok: true; sent: true; log_id: string }
  | { ok: false; error: string; log_id?: string | undefined }

/**
 * Per-tenant branding fields used by the shared `_layout.ts` email wrapper.
 * Matches the subset of `client` columns the dispatcher loads.
 */
export interface ClientBranding {
  name: string
  logo_light_url: string | null
  primary_colour: string | null
  email_footer_html: string | null
}

// ── Data shapes the dispatcher loads from Supabase ─────────────────────────

export interface BookingContactForDispatch {
  id: string
  full_name: string
  email: string
  mobile_e164: string | null
}

export interface BookingClientForDispatch extends ClientBranding {
  slug: string
  /**
   * Custom domain mapped to this client (e.g. `vvtest.verco.au`). Used by
   * `buildBookingPortalUrl()` to build resolvable booking-detail links for
   * email CTAs — Verco uses hostname-based tenant routing, so `appUrl`+slug
   * path concatenation produces broken URLs.
   */
  custom_domain: string | null
  reply_to_email: string | null
  email_from_name: string | null
  /**
   * Twilio Messaging Service SID (`MG…`) — required for SMS dispatch.
   * Null = tenant not configured for SMS; dispatcher skips the SMS channel
   * for this tenant and only sends email.
   */
  twilio_messaging_service_sid: string | null
}

export interface BookingItemForDispatch {
  service_name: string
  no_services: number
  is_extra: boolean
  line_charge_cents: number
}

export interface BookingForDispatch {
  id: string
  ref: string
  type: string
  client_id: string
  address: string
  collection_date: string
  total_charge_cents: number
  items: BookingItemForDispatch[]
  client: BookingClientForDispatch
  /** Nullable — edge case when a booking is missing a contact */
  contact: BookingContactForDispatch | null
}

// ── SendEmail contract ─────────────────────────────────────────────────────

export interface SendEmailParams {
  to: { email: string; name?: string }
  from: { email: string; name?: string }
  subject: string
  htmlBody: string
}

export type SendEmailResult =
  | { ok: true }
  | { ok: false; error: string; status?: number }

// ── SendSMS contract ───────────────────────────────────────────────────────

export interface SendSMSParams {
  /** Recipient phone in E.164 format (`+61412345678`). */
  to: string
  /** Plain-text body. Twilio segments at 160 GSM-7 chars / 70 UCS-2 chars. */
  body: string
  /** Messaging Service SID (`MG…`) — per-tenant alpha sender selection. */
  messagingServiceSid: string
}

export type SendSMSResult =
  | { ok: true; messageSid?: string }
  | { ok: false; error: string }

// ── notification_log row shape ─────────────────────────────────────────────

export interface NotificationLogRow {
  booking_id: string
  contact_id: string | null
  client_id: string
  channel: NotificationChannel
  notification_type: NotificationType
  to_address: string
  status: NotificationLogStatus
  error_message?: string
  /**
   * Per-notice idempotency discriminator (ncn_id / np_id). The stop model
   * raises one notice per waste stream, so a booking can legitimately have
   * several same-type notifications — each keyed by its notice id.
   */
  reference_id?: string | null
}

export interface RenderedEmail {
  subject: string
  html: string
}

export interface RenderedSMS {
  /** Plain-text SMS body. Aim for ≤160 GSM-7 chars to stay in one segment. */
  body: string
}

/**
 * Per-notification rendering output. The dispatcher fans out to each
 * non-null channel — a template that returns both `email` and `sms` will
 * fire both sends; one that returns only `email` is email-only.
 */
export interface RenderedNotification {
  email?: RenderedEmail
  sms?: RenderedSMS
}
