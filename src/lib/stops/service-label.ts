import type { Json } from '@/lib/supabase/types'
import type { WasteStream } from './stops'

/**
 * Resident-facing "Service type" labels for NCN/NP notices.
 *
 * A collection_stop bundles one waste stream's booked services (an `ancillary`
 * stop can hold Mattress + E-Waste + Whitegoods). Residents book by SERVICE
 * name ("Mattress"), not by internal stream ("ancillary"), so the notice names
 * the booked service(s). Names only — no quantities; an NCN is about *which*
 * collection, not how many items.
 *
 * Pure module (no `'use server'`, no DB, no framework) so it is unit-testable
 * in isolation — the closeout server actions import it. Node-only: the Deno
 * send-notification EF receives the finished label string via the payload and
 * never runs this code.
 */

/**
 * Fallback when a stop carries no usable `services_summary` (unobserved in prod:
 * 0/483 stops, but the column is populated by the push EF, not a schema
 * invariant — see the loud Sentry warn at the call site). Deliberately in
 * SERVICE vocabulary, not stream vocabulary, so the row never reads the
 * self-contradictory "Service type: Ancillary".
 */
const STREAM_FALLBACK_LABEL: Record<WasteStream, string> = {
  general: 'Bulk Waste',
  green: 'Green Waste',
  ancillary: 'Ancillary items',
  illegal_dumping: 'Illegal Dumping',
}

/**
 * collection_stop select for the closeout loader. Kept here (not inline in the
 * `'use server'` action) so a unit test can assert `services_summary` is
 * selected — if a refactor drops the column, the label silently reverts to the
 * fallback and this guard fails loudly instead.
 */
export const STOP_CLOSEOUT_SELECT =
  'id, stream, status, booking_id, client_id, services_summary, booking:booking_id(id, ref, status, type)'

/**
 * Element-level validation, not just `Array.isArray`: a malformed jsonb element
 * (`[null]`, `[{}]`, `[{ nam: 'x' }]`) must route to the fallback, never crash
 * `.map` (which runs *after* the stop is terminalised) or render
 * "Service type: undefined". Returns the trimmed name or `null` to drop it.
 * (Predicate-narrowing to a named shape is impossible here — `Json`'s object
 * member carries an index signature `ServiceSummaryEntry` lacks.)
 */
function serviceEntryName(value: Json): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const name = value.name
  return typeof name === 'string' && name.trim() !== '' ? name : null
}

/**
 * Per-stop path: derive the service-name label from `collection_stop.services_summary`.
 * Returns `fromFallback` so the caller can emit a loud (Sentry) warning when the
 * summary was empty/malformed and the stream fallback was used.
 */
export function serviceLabelFromSummary(
  summary: Json | null | undefined,
  stream: WasteStream,
): { label: string; fromFallback: boolean } {
  const names = Array.isArray(summary)
    ? summary.map(serviceEntryName).filter((name): name is string => name !== null)
    : []
  return names.length > 0
    ? { label: names.join(', '), fromFallback: false }
    : { label: STREAM_FALLBACK_LABEL[stream], fromFallback: true }
}

/**
 * Legacy per-booking path (stop-less bookings): the whole visit is closed at
 * once, so name every distinct booked service, sorted for determinism.
 * `undefined` when there are none → the notice email omits the row entirely.
 */
export function distinctServiceNames(
  items: ReadonlyArray<{ service: { name: string } }> | null | undefined,
): string | undefined {
  const names = [...new Set((items ?? []).map((item) => item.service.name))].sort()
  return names.length > 0 ? names.join(', ') : undefined
}
