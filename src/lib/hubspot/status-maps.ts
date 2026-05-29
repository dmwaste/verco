/**
 * Verco → HubSpot status mappings (pure).
 *
 * Verified against live HubSpot (portal 442091910, VER-235) + `src/lib/supabase/types.ts`:
 *   - Ticket Support Pipeline: hs_pipeline = "0"; stages 1 New / 2 Waiting on contact /
 *     3 Waiting on us / 4 Closed.
 *   - booking_status enum (10) and ticket_status enum (5) are the real Verco enums — NOT the
 *     NCN/NP state machine (that's a different table).
 */

/** HubSpot Support Pipeline id (confirmed live). */
export const SUPPORT_PIPELINE_ID = '0'

/** HubSpot Support Pipeline stage ids (confirmed live). */
export const TICKET_STAGE = {
  NEW: '1',
  WAITING_ON_CONTACT: '2',
  WAITING_ON_US: '3',
  CLOSED: '4',
} as const

/** All 10 `booking_status` enum values (source of truth: types.ts). */
export const BOOKING_STATUSES = [
  'Pending Payment',
  'Submitted',
  'Confirmed',
  'Scheduled',
  'Completed',
  'Cancelled',
  'Non-conformance',
  'Nothing Presented',
  'Rebooked',
  'Missed Collection',
] as const

/** All 5 `ticket_status` enum values (source of truth: types.ts). */
export const TICKET_STATUSES = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'] as const

/**
 * Verco `booking_status` → HubSpot Order `hs_external_order_status` (a free string).
 * The Verco statuses are already CRM-readable, so this is an explicit allow-list that
 * passes known values through and falls back to the raw value for any future/unknown status
 * (never drops information). Post clean-break, only EF-written values appear, so no vocab clash.
 */
export function bookingStatusToOrderStatus(status: string): string {
  return (BOOKING_STATUSES as readonly string[]).includes(status) ? status : status || 'Unknown'
}

/**
 * Verco `ticket_status` → HubSpot Support Pipeline stage id.
 * Unknown/empty → New ('1') as the safe default (a ticket is never silently dropped from the pipeline).
 */
export function ticketStatusToPipelineStage(status: string): string {
  switch (status) {
    case 'open':
      return TICKET_STAGE.NEW
    case 'waiting_on_customer':
      return TICKET_STAGE.WAITING_ON_CONTACT
    case 'in_progress':
      return TICKET_STAGE.WAITING_ON_US
    case 'resolved':
    case 'closed':
      return TICKET_STAGE.CLOSED
    default:
      return TICKET_STAGE.NEW
  }
}
