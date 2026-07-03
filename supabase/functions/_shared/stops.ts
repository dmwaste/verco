// Stop-generation logic mirrored in src/lib/stops/stops.ts — keep in sync
// (scripts/sync-mirrors.sh; _shared/ is the source of truth).

/**
 * Pure helpers for the collection_stop model (stop = booking × waste stream).
 *
 * Used by the push-orders-to-optimoroute EF to group booking items into
 * per-stream stops and build routing-engine orders, and by tests to assert
 * parity with the DB-side rollup trigger
 * (rollup_booking_status_from_stops, migration 20260610010100).
 */

export type WasteStream = 'general' | 'green' | 'ancillary' | 'illegal_dumping'

export type StopStatus =
  | 'Pending'
  | 'Completed'
  | 'Non-conformance'
  | 'Nothing Presented'
  | 'Cancelled'

export interface StopItem {
  no_services: number
  service: {
    name: string
    waste_stream: WasteStream
  }
}

export interface ServiceSummaryEntry {
  name: string
  qty: number
}

/** orderNo suffix per stream: {booking.ref}-{suffix}, e.g. KWN-1-AB12CD-GEN */
export const STREAM_SUFFIX: Record<WasteStream, string> = {
  general: 'GEN',
  green: 'GRN',
  ancillary: 'ANC',
  illegal_dumping: 'ID',
}

/**
 * Routing priority per stream. General runs first so the general and green
 * passes stay segregated — the engine schedules H-priority orders ahead of
 * the rest within a route.
 */
export const STREAM_PRIORITY: Record<WasteStream, 'H' | 'M'> = {
  general: 'H',
  green: 'M',
  ancillary: 'M',
  illegal_dumping: 'M',
}

/**
 * Required OptimoRoute vehicle feature per stream — a HARD routing constraint
 * (the engine only assigns an order to a vehicle carrying the feature), unlike
 * STREAM_PRIORITY which merely orders stops within a route. Codes match the
 * account's Vehicle features. Bulk-truck streams (general + illegal_dumping)
 * both require BLK — note general → BLK, deliberately NOT the GEN order-suffix.
 */
export const STREAM_VEHICLE_FEATURE: Record<WasteStream, string> = {
  general: 'BLK',
  green: 'GRN',
  ancillary: 'ANC',
  illegal_dumping: 'BLK',
}

/** Required vehicle-feature codes for a stop's stream. */
export function vehicleFeaturesForStream(stream: WasteStream): string[] {
  return [STREAM_VEHICLE_FEATURE[stream]]
}

/** Planning duration per stop, minutes. Flat v1 value across streams. */
export const STOP_DURATION_MINUTES = 5

export function buildOrderNo(bookingRef: string, stream: WasteStream): string {
  return `${bookingRef}-${STREAM_SUFFIX[stream]}`
}

/**
 * Groups booking items into their waste-stream passes. Generic so callers
 * carrying extra fields (e.g. collection_date_id) keep them typed through
 * the grouping — items are passed by reference, never copied.
 */
export function groupItemsByStream<T extends StopItem>(items: T[]): Map<WasteStream, T[]> {
  const groups = new Map<WasteStream, T[]>()
  for (const item of items) {
    const stream = item.service.waste_stream
    const group = groups.get(stream)
    if (group) {
      group.push(item)
    } else {
      groups.set(stream, [item])
    }
  }
  return groups
}

/**
 * Stop state-machine parity with the DB trigger enforce_stop_state_transition
 * (migration 20260610010100) — the trigger is authoritative; this exists for
 * UI checks and tests. Pending → any terminal for all writers; Cancelled →
 * Pending only for privileged writers (the push EF reviving a stop whose
 * stream reappeared after a post-push amendment); terminal states otherwise
 * immutable.
 */
export function canStopTransition(
  from: StopStatus,
  to: StopStatus,
  opts: { privileged?: boolean } = {},
): boolean {
  if (from === to) return false
  if (from === 'Pending') return true
  if (from === 'Cancelled' && to === 'Pending') return opts.privileged === true
  return false
}

/**
 * services_summary jsonb payload for a stop: what THIS pass collects.
 * Sorted by name so the output is deterministic regardless of DB row order —
 * the push EF diffs summaries to decide whether a stop needs re-pushing.
 */
export function buildServicesSummary(items: StopItem[]): ServiceSummaryEntry[] {
  return items
    .map((item) => ({ name: item.service.name, qty: item.no_services }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Structured OptimoRoute order notes — a labelled block the crew reads in the
 * driver app / order detail, e.g.
 *
 *   Services: E-Waste x1, Mattress x2
 *   Location: Front Verge
 *   Notes: Will be on the side street of the property
 *
 * Each line is omitted when its source is empty (a bare bulk stop is just
 * "Services: Bulk Waste x1"). location = booking.location (waste placement),
 * driverNotes = booking.notes (resident instructions for the crew).
 */
export function buildOrderNotes(
  summary: ServiceSummaryEntry[],
  location?: string | null,
  driverNotes?: string | null,
): string {
  const lines: string[] = []
  if (summary.length > 0) {
    lines.push(`Services: ${summary.map((s) => `${s.name} x${s.qty}`).join(', ')}`)
  }
  if (location && location.trim() !== '') {
    lines.push(`Location: ${location.trim()}`)
  }
  if (driverNotes && driverNotes.trim() !== '') {
    lines.push(`Notes: ${driverNotes.trim()}`)
  }
  return lines.join('\n')
}

/**
 * Booking-status rollup over a booking's stop statuses — exception wins.
 * Mirrors rollup_booking_status_from_stops exactly; the DB trigger is
 * authoritative, this exists for tests and UI display.
 *
 * Returns null while any stop is Pending, or when every stop is Cancelled
 * (the booking-cancel path owns that case).
 */
export function computeRollup(
  statuses: StopStatus[],
): 'Completed' | 'Non-conformance' | 'Nothing Presented' | null {
  if (statuses.length === 0) return null
  if (statuses.some((s) => s === 'Pending')) return null
  const live = statuses.filter((s) => s !== 'Cancelled')
  if (live.length === 0) return null
  if (live.some((s) => s === 'Non-conformance')) return 'Non-conformance'
  if (live.some((s) => s === 'Nothing Presented')) return 'Nothing Presented'
  return 'Completed'
}
