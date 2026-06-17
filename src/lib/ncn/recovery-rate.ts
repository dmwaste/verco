/**
 * Recovery Rate — RECOVERY card of the VER-179 SLA dashboard (spec §3.5).
 *
 * Measures the share of NCN/NP notices that were *ever* rebooked AND the
 * rebooked collection actually completed. Unlike RECT (rectification ≤ 2
 * working days) there is **no time bound** — a notice that took three weeks to
 * recover still counts as recovered here.
 *
 * Pure + deterministic: no Supabase, no network, no wall-clock reads. The
 * caller does the split-query + stitch (NCN and NP each have two FKs to
 * `booking`, the documented multi-FK embed trap — never embed the rebooked
 * booking) and hands this fn a flat list of notices plus a status lookup.
 *
 * Denominator (recoverable): **all** in-scope NCN + NP notices, NOT pre-filtered
 * by their own status. A still-Issued/Disputed notice that was never rebooked is
 * a recovery *failure*, so it belongs in the denominator. Likewise a
 * refund-resolved notice (`Resolved` with no `rescheduled_booking_id`, spec
 * §8 #4) is a non-recovery, not an exclusion.
 *
 * Numerator (recovered): notices whose `rescheduledBookingId` is set AND whose
 * rebooked booking's status (looked up in `rebookedStatusById`) is exactly
 * `'Completed'`. Any in-flight status (Submitted/Confirmed/Scheduled), a
 * Cancelled rebook, a missing map entry, or a null/empty id → non-recovery.
 */

/** Internal recovery target (~95%) — reference line, tunable. */
export const RECOVERY_TARGET_PCT = 95

/**
 * Below this many recoverable notices the card shows the raw fraction +
 * "Building data" instead of a colour-able percentage (spec §3.5 / §5.4).
 */
export const RECOVERY_LOW_N = 5

/** Booking status that proves a notice was recovered. */
const RECOVERED_STATUS = 'Completed'

/**
 * One in-scope notice (NCN or NP). The caller maps both notice types onto this
 * shape; the fn doesn't distinguish them — it only reads the rebook target.
 */
export interface RecoveryNotice {
  /** FK to the rebooked booking, or null if the notice was never rebooked. */
  rescheduledBookingId: string | null
}

export interface RecoveryRateResult {
  /** All in-scope NCN + NP notices (the denominator). */
  recoverable: number
  /** Notices rebooked AND completed (the numerator). */
  recovered: number
  /** `recovered / recoverable × 100`, or null when `recoverable` is 0. */
  rate: number | null
  /** True when there are no in-scope notices at all. */
  isEmpty: boolean
  /** True when `0 < recoverable < RECOVERY_LOW_N` (raw fraction, no %). */
  isLowN: boolean
}

/**
 * Compute the recovery rate.
 *
 * @param notices            all in-scope NCN + NP notices (already area/client
 *                           scoped by the caller)
 * @param rebookedStatusById map of rebooked booking id → its current status,
 *                           built from the caller's stitch query
 */
export function recoveryRate(
  notices: readonly RecoveryNotice[],
  rebookedStatusById: ReadonlyMap<string, string>,
): RecoveryRateResult {
  const recoverable = notices.length

  let recovered = 0
  for (const notice of notices) {
    const id = notice.rescheduledBookingId
    if (!id) continue // null / undefined / empty string → never rebooked
    if (rebookedStatusById.get(id) === RECOVERED_STATUS) recovered += 1
  }

  const rate = recoverable === 0 ? null : (recovered / recoverable) * 100

  return {
    recoverable,
    recovered,
    rate,
    isEmpty: recoverable === 0,
    isLowN: recoverable > 0 && recoverable < RECOVERY_LOW_N,
  }
}
