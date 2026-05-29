/**
 * Verco → HubSpot sync — pure mapping types.
 *
 * Mirrors the `src/lib/pricing` pattern: zero Supabase dependency, lean input
 * interfaces (not the generated DB Row types) so the logic is portable between
 * the `sync-to-hubspot` Edge Function and Vitest. The Edge Function resolves all
 * joins/lookups (collection_date, address, the ticket's contact phone, the
 * booking ref behind a ticket) and passes the assembled inputs in.
 *
 * Spec: docs/superpowers/specs/2026-05-29-verco-hubspot-sync-design.md (§4, §6, VER-237).
 */

/** A HubSpot batch-upsert input record: dedupe on `idProperty` = `id`. */
export interface HubspotUpsertRecord {
  /** The unique property HubSpot matches on (e.g. 'email', 'hs_external_order_id'). */
  idProperty: string
  /** The value of `idProperty` for this record. */
  id: string
  /** HubSpot property keys → string values (HubSpot stores all properties as strings). */
  properties: Record<string, string>
}

/** Options injected by the caller (EF) so the pure mappers never hardcode a host. */
export interface MapOptions {
  /**
   * Base URL for Verco admin deeplinks, no trailing slash (e.g. 'https://app.verco.au').
   * Verco is per-client white-labelled, so the host is the EF's decision, not the mapper's.
   */
  vercoBaseUrl: string
}

/** Verco `contacts` fields the contact mapper needs (resolved by the EF). */
export interface VercoContactInput {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  mobile_e164: string | null
}

/** Verco `booking` fields the order mapper needs (collection_date + address pre-resolved). */
export interface VercoBookingInput {
  id: string
  ref: string
  /** `booking_status` enum value. */
  status: string
  /** Date-only `YYYY-MM-DD` (MIN over booking_item collection dates), AWST, no timezone. Null if none. */
  collection_date: string | null
  /** `eligible_properties.formatted_address ?? address`, resolved by the EF. */
  address: string | null
}

/** Verco `service_ticket` fields the ticket mapper needs (phone + booking_ref resolved by the EF). */
export interface VercoTicketInput {
  id: string
  subject: string
  /** Maps to HubSpot ticket `content`. */
  message: string
  /** `ticket_category` enum → HubSpot `query_type`. */
  category: string
  /** `ticket_status` enum. */
  status: string
  /** The ticket contact's `mobile_e164`, resolved by the EF (no phone column on the ticket). */
  phone_number: string | null
  /** ISO timestamp. */
  created_at: string
  /** ISO timestamp, null while the ticket is open. */
  closed_at: string | null
  /** The Verco booking `ref` behind this ticket (when `booking_id` set), resolved by the EF. */
  booking_ref: string | null
}

/** Compound keyset cursor for `(updated_at, id)` paging. */
export interface SyncCursor {
  updated_at: string
  id: string
}
