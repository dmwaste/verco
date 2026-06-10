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

/** Planning duration per stop, minutes. Flat v1 value across streams. */
export const STOP_DURATION_MINUTES = 5

export function buildOrderNo(bookingRef: string, stream: WasteStream): string {
  return `${bookingRef}-${STREAM_SUFFIX[stream]}`
}

/** Groups booking items into their waste-stream passes. */
export function groupItemsByStream(items: StopItem[]): Map<WasteStream, StopItem[]> {
  const groups = new Map<WasteStream, StopItem[]>()
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

/** services_summary jsonb payload for a stop: what THIS pass collects. */
export function buildServicesSummary(items: StopItem[]): ServiceSummaryEntry[] {
  return items.map((item) => ({ name: item.service.name, qty: item.no_services }))
}

/** Human-readable order notes, e.g. "General x2, Mattress x1". Never PII. */
export function buildOrderNotes(summary: ServiceSummaryEntry[]): string {
  return summary.map((s) => `${s.name} x${s.qty}`).join(', ')
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
