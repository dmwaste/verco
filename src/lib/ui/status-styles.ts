/**
 * Centralised status → colour mappings for all entity types.
 * Import getStatusStyle() instead of defining STATUS_STYLE locally.
 *
 * Colours come from the semantic status tokens in globals.css
 * (--color-status-success/warn/error/info + -bg variants). Add new statuses
 * with the shared pairs below — never raw hexes or stock Tailwind colours.
 */

export interface StatusStyle {
  bg: string
  text: string
  label: string
  /** Optional dot colour for inline status indicators */
  dot?: string
}

// Semantic pairs — the only status colours in the app
const SUCCESS = { bg: 'bg-status-success-bg', text: 'text-status-success' }
const WARN = { bg: 'bg-status-warn-bg', text: 'text-status-warn' }
const ERROR = { bg: 'bg-status-error-bg', text: 'text-status-error' }
const INFO = { bg: 'bg-status-info-bg', text: 'text-status-info' }
// Non-semantic accent for "parked with us" states (Scheduled, waiting, rebooked-away)
const PURPLE = { bg: 'bg-[#F3EEFF]', text: 'text-[#805AD5]' }

// ── Booking statuses ─────────────────────────────────────────────────────────

const BOOKING: Record<string, StatusStyle> = {
  'Pending Payment': { ...WARN, label: 'Pending Payment' },
  Submitted:         { ...INFO, label: 'Submitted' },
  Confirmed:         { ...SUCCESS, label: 'Confirmed' },
  Scheduled:         { ...PURPLE, label: 'Scheduled' },
  Completed:         { bg: 'bg-gray-100', text: 'text-gray-700', label: 'Completed' },
  Cancelled:         { ...ERROR, label: 'Cancelled' },
  'Non-conformance': { ...ERROR, label: 'Non-Conformance' },
  'Nothing Presented': { ...WARN, label: 'Nothing Presented' },
  Rebooked:          { ...INFO, label: 'Rebooked' },
  'Missed Collection': { ...ERROR, label: 'Missed Collection' },
}

// ── NCN statuses ─────────────────────────────────────────────────────────────

const NCN: Record<string, StatusStyle> = {
  Issued:          { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Issued' },
  Open:            { ...WARN, label: 'Open' },
  Disputed:        { ...ERROR, label: 'Disputed' },
  // Info, not warn — reconciled with the NP map (same word, adjacent nav items)
  'Under Review':  { ...INFO, label: 'Under Review' },
  Resolved:        { ...SUCCESS, label: 'Resolved' },
  Rescheduled:     { ...INFO, label: 'Rescheduled' },
  Closed:          { bg: 'bg-gray-50', text: 'text-gray-400', label: 'Closed' },
}

// ── NP statuses (same palette as NCN, slightly different set) ────────────────

const NP: Record<string, StatusStyle> = {
  Issued:          { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Issued' },
  Open:            { ...WARN, label: 'Open' },
  Disputed:        { ...ERROR, label: 'Disputed' },
  'Under Review':  { ...INFO, label: 'Under Review' },
  Resolved:        { ...SUCCESS, label: 'Resolved' },
  Rebooked:        { ...PURPLE, label: 'Rebooked' },
  Closed:          { bg: 'bg-gray-50', text: 'text-gray-400', label: 'Closed' },
}

// ── Ticket statuses ──────────────────────────────────────────────────────────

const TICKET: Record<string, StatusStyle> = {
  open:                { ...WARN, label: 'Open', dot: 'bg-status-warn' },
  in_progress:         { ...INFO, label: 'In Progress', dot: 'bg-status-info' },
  waiting_on_customer: { ...PURPLE, label: 'Awaiting Reply', dot: 'bg-[#805AD5]' },
  resolved:            { ...SUCCESS, label: 'Resolved', dot: 'bg-status-success' },
  closed:              { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Closed', dot: 'bg-gray-400' },
}

// ── Ticket priorities ────────────────────────────────────────────────────────

const TICKET_PRIORITY: Record<string, StatusStyle> = {
  low:    { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Low' },
  normal: { ...INFO, label: 'Normal' },
  high:   { ...WARN, label: 'High' },
  urgent: { ...ERROR, label: 'Urgent' },
}

// ── Refund statuses ──────────────────────────────────────────────────────────

const REFUND: Record<string, StatusStyle> = {
  Pending:  { ...WARN, label: 'Pending' },
  Approved: { ...SUCCESS, label: 'Approved' },
  Rejected: { ...ERROR, label: 'Rejected' },
}

// ── Bug report statuses ──────────────────────────────────────────────────────

const BUG: Record<string, StatusStyle> = {
  new:          { ...WARN, label: 'New' },
  triaged:      { ...INFO, label: 'Triaged' },
  in_progress:  { ...PURPLE, label: 'In Progress' },
  resolved:     { ...SUCCESS, label: 'Resolved' },
  closed:       { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Closed' },
  wont_fix:     { bg: 'bg-gray-100', text: 'text-gray-500', label: "Won't Fix" },
}

// ── Lookup ───────────────────────────────────────────────────────────────────

const ENTITIES = {
  booking: BOOKING,
  ncn: NCN,
  np: NP,
  ticket: TICKET,
  ticketPriority: TICKET_PRIORITY,
  refund: REFUND,
  bug: BUG,
} as const

export type StatusEntity = keyof typeof ENTITIES

const FALLBACK: StatusStyle = { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Unknown' }

export function getStatusStyle(entity: StatusEntity, status: string): StatusStyle {
  return ENTITIES[entity][status] ?? FALLBACK
}

/** Get all status keys for an entity (useful for filter dropdowns) */
export function getStatusOptions(entity: StatusEntity): string[] {
  return Object.keys(ENTITIES[entity])
}
