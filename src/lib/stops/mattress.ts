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
 * Count validation for the closeout actions. When the stop does NOT log
 * mattresses, any submitted count is DISCARDED (returns null) — a
 * non-logging tenant's stops must stay NULL ("never logged"), never collect
 * stray zeros that would read as real observations in the report.
 *
 * A MISSING count on a logging stop is accepted as NULL ("uncounted"), not
 * rejected: a crew phone still running a pre-#487 bundle can never send a
 * count, and hard-failing stranded every VV bulk closeout on 03/08/2026
 * (ADR 0011 — resident service beats report completeness). The current UI
 * always sends a number when the counter is shown, so NULL here means a
 * stale client — the action logs it to Sentry via isMissingRequiredCount.
 * Invalid VALUES (negative, fractional, absurd) are still rejected.
 */
export function validateMattressCount(
  required: boolean,
  count: number | null | undefined,
): Result<number | null> {
  if (!required || count == null) return { ok: true, data: null }
  if (!Number.isInteger(count) || count < 0) {
    return {
      ok: false,
      error: 'Mattress count must be a whole number — check and re-enter.',
    }
  }
  if (count > MATTRESS_COUNT_MAX) {
    return { ok: false, error: 'Mattress count looks too high — check and re-enter.' }
  }
  return { ok: true, data: count }
}

/**
 * True when a logging stop is closing WITHOUT a count — i.e. the caller is a
 * client build that predates the counter. The closeout proceeds (count stays
 * NULL = "uncounted"), but the action reports it so stale phones surface in
 * Sentry instead of silently thinning the mattress report.
 */
export function isMissingRequiredCount(
  required: boolean,
  count: number | null | undefined,
): boolean {
  return required && count == null
}
