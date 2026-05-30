/**
 * Verco → HubSpot entity mappers (pure).
 *
 * Each mapper returns a `HubspotUpsertRecord` ({ idProperty, id, properties }) ready for
 * HubSpot's batch upsert. Dedupe keys (VER-235-verified):
 *   - Contact → `email` (HubSpot-native; bridges the Make-era contacts)
 *   - Order   → native `hs_external_order_id` (= booking.id; no custom property needed)
 *   - Ticket  → custom unique `verco_ticket_id` (= service_ticket.id)
 *
 * Optional fields are omitted when null/absent (never sent as empty strings, which would
 * clear an existing HubSpot value on re-upsert).
 *
 * Spec: docs/superpowers/specs/2026-05-29-verco-hubspot-sync-design.md §4.
 */
import type { HubspotUpsertRecord, MapOptions, VercoBookingInput, VercoContactInput, VercoTicketInput } from './types'
import { SUPPORT_PIPELINE_ID, bookingStatusToOrderStatus, ticketStatusToPipelineStage } from './status-maps'

type AdminEntity = 'bookings' | 'service-tickets'

/** Build a Verco admin deeplink, tolerating a trailing slash on the base URL. */
export function vercoDeeplink(baseUrl: string, entity: AdminEntity, id: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/admin/${entity}/${id}`
}

/** Set `props[key] = value` only when value is a non-empty string. */
function setIf(props: Record<string, string>, key: string, value: string | null | undefined): void {
  if (value != null && value !== '') props[key] = value
}

/**
 * Verco contact → HubSpot Contact (0-1), upsert by email.
 * Returns null when the contact has no email — email is the dedupe key, so an
 * emailless contact must be skipped, not upserted with a null key (eng-review Issue 2).
 * No `verco_url` deeplink: there is no /admin/contacts page (TD1).
 */
export function mapContactToHubspot(c: VercoContactInput, _opts: MapOptions): HubspotUpsertRecord | null {
  if (c.email == null || c.email === '') return null
  const properties: Record<string, string> = { email: c.email, verco_contact_id: c.id }
  setIf(properties, 'firstname', c.first_name)
  setIf(properties, 'lastname', c.last_name)
  setIf(properties, 'phone', c.mobile_e164)
  return { idProperty: 'email', id: c.email, properties }
}

/**
 * Verco booking → HubSpot Order (0-123), upsert by native `hs_external_order_id`.
 * `amount` is intentionally omitted (TD2): the account is USD-only, and writing AUD into the
 * native USD `amount` would silently mis-sum HubSpot revenue reports.
 */
export function mapBookingToOrder(b: VercoBookingInput, opts: MapOptions): HubspotUpsertRecord {
  const properties: Record<string, string> = {
    hs_external_order_id: b.id,
    hs_order_name: b.ref,
    hs_external_order_status: bookingStatusToOrderStatus(b.status),
    hs_external_order_url: vercoDeeplink(opts.vercoBaseUrl, 'bookings', b.id),
  }
  setIf(properties, 'collection_date', b.collection_date)
  setIf(properties, 'address', b.address)
  return { idProperty: 'hs_external_order_id', id: b.id, properties }
}

/**
 * Verco service_ticket → HubSpot Ticket (0-5), upsert by custom unique `verco_ticket_id`.
 * Real column mapping (eng-review F1): content←message, query_type←category, phone_number←the
 * contact's mobile (no phone column on the ticket), time_to_close←(closed_at − created_at) ms.
 */
export function mapTicketToHubspotTicket(t: VercoTicketInput, opts: MapOptions): HubspotUpsertRecord {
  const properties: Record<string, string> = {
    verco_ticket_id: t.id,
    subject: t.subject,
    content: t.message,
    query_type: t.category,
    hs_pipeline: SUPPORT_PIPELINE_ID,
    hs_pipeline_stage: ticketStatusToPipelineStage(t.status),
    verco_url: vercoDeeplink(opts.vercoBaseUrl, 'service-tickets', t.id),
  }
  setIf(properties, 'phone_number', t.phone_number)
  setIf(properties, 'booking_ref', t.booking_ref)
  const ttc = timeToCloseMs(t.created_at, t.closed_at)
  setIf(properties, 'time_to_close', ttc)
  return { idProperty: 'verco_ticket_id', id: t.id, properties }
}

/** Milliseconds between created_at and closed_at as a string; null while open or on bad input. */
function timeToCloseMs(createdAt: string, closedAt: string | null): string | null {
  if (!closedAt) return null
  const start = new Date(createdAt).getTime()
  const end = new Date(closedAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
  return String(end - start)
}
