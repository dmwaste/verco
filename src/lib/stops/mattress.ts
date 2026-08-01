import type { Result } from '@/lib/result'
import type { WasteStream } from '@/lib/stops/stops'

/**
 * Mattress logging at stop closeout (#487): tenants that roll mattresses into
 * the bulk booking (Verge Valet) have no per-mattress record, so the crew
 * logs a count when the flagged pass closes out. `client.
 * mattress_closeout_stream` names that pass; NULL = the tenant never logs
 * (Kwinana books Mattress as its own service instead).
 */

/** Sanity ceiling — a bulk stop is one property's verge pile. */
export const MATTRESS_COUNT_MAX = 999

export function stopLogsMattresses(
  clientCloseoutStream: WasteStream | null | undefined,
  stopStream: WasteStream,
): boolean {
  return clientCloseoutStream != null && clientCloseoutStream === stopStream
}

/**
 * Fail-closed count validation for the closeout actions. When the stop does
 * NOT log mattresses, any submitted count is DISCARDED (returns null) — a
 * non-logging tenant's stops must stay NULL ("never logged"), never collect
 * stray zeros that would read as real observations in the report.
 */
export function validateMattressCount(
  required: boolean,
  count: number | null | undefined,
): Result<number | null> {
  if (!required) return { ok: true, data: null }
  if (count == null || !Number.isInteger(count) || count < 0) {
    return {
      ok: false,
      error: 'Enter the mattress count (0 if none) before closing this stop.',
    }
  }
  if (count > MATTRESS_COUNT_MAX) {
    return { ok: false, error: 'Mattress count looks too high — check and re-enter.' }
  }
  return { ok: true, data: count }
}
