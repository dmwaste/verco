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

/**
 * orderNo suffix per stream: {booking.ref}-{suffix}, e.g. KWN-1-AB12CD-B.
 * Short single letters (B/G/A) keep the OR reference neat; each stream still
 * has a DISTINCT suffix, which is what guarantees a multi-stream booking's
 * orders get unique orderNos (OR's primary key) — the vehicle feature routes
 * the truck, the suffix identifies the order. illegal_dumping keeps 'ID'.
 */
export const STREAM_SUFFIX: Record<WasteStream, string> = {
  general: 'B',
  green: 'G',
  ancillary: 'A',
  illegal_dumping: 'ID',
}

/**
 * Routing priority per stream. Green runs first (High) so the green pass is
 * scheduled ahead within a route; bulk (general) and ancillary are Medium.
 * The engine schedules H-priority orders ahead of the rest within a route.
 */
export const STREAM_PRIORITY: Record<WasteStream, 'H' | 'M'> = {
  green: 'H',
  general: 'M',
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
 * Content equality for services_summary payloads, independent of object key
 * order and entry order. Postgres jsonb normalises object keys ({"qty": …,
 * "name": …}) while buildServicesSummary emits {name, qty}, so a
 * JSON.stringify comparison flags every stored summary as changed — which made
 * the push EF reset pushed_at and re-push every pending stop every night
 * (12/07/2026 incident: the run outgrew its invocation window and died between
 * reset and re-push, stranding every stop as "never pushed").
 */
export function servicesSummariesEqual(
  a: ServiceSummaryEntry[],
  b: ServiceSummaryEntry[],
): boolean {
  // The stored side is unconstrained jsonb — the type signature can lie
  // (manual row surgery, legacy shapes). Malformed input must read as
  // "changed" (one refresh converges it), never throw: a throw escapes the
  // per-stop loop and aborts the whole nightly push.
  const wellFormed = (xs: ServiceSummaryEntry[]) =>
    Array.isArray(xs) && xs.every((e) => typeof e === 'object' && e !== null)
  if (!wellFormed(a) || !wellFormed(b)) return false
  if (a.length !== b.length) return false
  const key = (e: ServiceSummaryEntry) => `${e.name}\u0000${e.qty}`
  const as = a.map(key).sort()
  const bs = b.map(key).sort()
  return as.every((v, i) => v === bs[i])
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
 * Recognised on-property waste placements — mirror of the booking form's
 * LOCATION_OPTIONS + the staff-only 'Other'. Kept here (not imported from
 * src/lib/booking/schemas) because this module is the Deno EF's source of truth.
 */
export const WASTE_LOCATION_VALUES = ['Front Verge', 'Side Verge', 'Driveway', 'Other'] as const

/**
 * booking.location is overloaded — for most bookings (legacy/import) it holds
 * the street ADDRESS, only sometimes the on-property placement. Surface it as a
 * waste location ONLY when it's a recognised placement; otherwise null (the
 * address is already the order's address, so repeating it as "Location:" is
 * noise). Trims first so trailing-space values still match.
 */
export function wasteLocationOrNull(location: string | null | undefined): string | null {
  if (!location) return null
  const trimmed = location.trim()
  return (WASTE_LOCATION_VALUES as readonly string[]).includes(trimmed) ? trimmed : null
}

/** Composite key matching a stop to a booking item: collection date × waste stream. */
export function stopItemKey(collectionDateId: string, stream: WasteStream): string {
  return `${collectionDateId}:${stream}`
}

/**
 * Pass-1 orphan reconciliation: should an existing Pending stop be cancelled?
 *
 *  - Booking present in `desired` (has a locked-date item): cancel iff this stop's
 *    stream is no longer among the booking's desired streams (an in-window edit
 *    dropped the stream).
 *  - Booking absent from `desired` and no longer live: cancel (cancelled/terminal).
 *  - Booking absent from `desired` but STILL live: its collection moved off the
 *    locked window — e.g. rescheduled to a not-yet-locked date. Cancel iff the
 *    booking no longer has a current item on this stop's (date, stream). This is
 *    the phantom-order fix: the old assumption ("a live booking can't be absent
 *    from desired") left the stale stop — and its OR order — behind forever. The
 *    positive item check means we never over-cancel (a SYNC delete loses OR route
 *    planning), and it self-heals: a fresh stop is created when the new date locks.
 */
export function shouldCancelOrphanStop(args: {
  stopStream: WasteStream
  stopDateId: string
  desiredStreamsForBooking: readonly WasteStream[] | null
  bookingLive: boolean
  currentItemKeys: ReadonlySet<string>
}): boolean {
  const { stopStream, stopDateId, desiredStreamsForBooking, bookingLive, currentItemKeys } = args
  if (desiredStreamsForBooking !== null) {
    return !desiredStreamsForBooking.includes(stopStream)
  }
  if (!bookingLive) return true
  return !currentItemKeys.has(stopItemKey(stopDateId, stopStream))
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
