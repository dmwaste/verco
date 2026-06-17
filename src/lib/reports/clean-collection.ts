/**
 * BC — Clean Collection Rate (VER-179 §3.1).
 *
 * Pure, deterministic calc for the admin SLA dashboard: no Supabase imports,
 * no network, no wall-clock reads. The caller (reports-client) does all the
 * FY/area-scoped fetching and hands two booking-id sets in:
 *
 *   - `eligibleBookingIds`        — bookings that reached the field this FY
 *     (status in Completed / Non-conformance / Nothing Presented / Scheduled /
 *     Missed Collection), already scoped by client/FY/area.
 *   - `contractorFaultNcnBookingIds` — booking ids carrying a
 *     `contractor_fault = true` NCN, fetched via the booking embed.
 *
 * rate = (eligible − miss) / eligible × 100, where `miss` is the NCN set
 * INTERSECTED with the eligible set. We never trust a raw NCN count: an NCN
 * can point at a booking outside the eligible set (different FY, different
 * area, soft-deleted), so only NCNs whose booking is in the eligible set count
 * against D&M's clean-collection SLA. Intersection also caps `miss` at
 * `eligible`, so pct can never go negative.
 *
 * BC measures D&M's service delivery — a "miss" is a collection D&M failed to
 * complete correctly (contractor_fault = true). Resident non-compliance
 * (contractor_fault = false) is filtered out upstream by the caller and never
 * reaches this fn.
 */

/** WMRC contractual clean-collection target (%). Pass at/above, below = amber. */
export const CLEAN_TARGET_PCT = 98

/**
 * Minimum eligible-booking sample before a coloured pass/fail % is shown.
 * Below this the card shows the raw fraction + "Building data" (spec §3.1).
 */
export const CLEAN_LOW_N = 20

export interface CleanCollectionInput {
  /** Eligible booking ids (reached the field), already FY/area-scoped. */
  eligibleBookingIds: Set<string>
  /** Contractor-fault NCN booking ids; intersected with the eligible set. */
  contractorFaultNcnBookingIds: Set<string>
}

export interface CleanCollectionResult {
  /** Eligible bookings (the denominator). */
  eligible: number
  /** Eligible bookings with a contractor-fault NCN (the intersected numerator). */
  miss: number
  /** Clean-collection % (0–100), or null when there are no eligible bookings. */
  pct: number | null
  /** True when there are no eligible bookings (denominator 0). */
  isEmpty: boolean
  /** True when 0 < eligible < CLEAN_LOW_N — show raw fraction, no coloured %. */
  isLowN: boolean
}

export function computeCleanCollection(
  input: CleanCollectionInput,
): CleanCollectionResult {
  const eligibleIds = input?.eligibleBookingIds ?? new Set<string>()
  const ncnIds = input?.contractorFaultNcnBookingIds ?? new Set<string>()

  const eligible = eligibleIds.size

  // Intersect: only NCNs whose booking is in the eligible set are a miss.
  let miss = 0
  for (const id of ncnIds) {
    if (eligibleIds.has(id)) miss += 1
  }

  if (eligible === 0) {
    return { eligible: 0, miss: 0, pct: null, isEmpty: true, isLowN: false }
  }

  const pct = ((eligible - miss) / eligible) * 100

  return {
    eligible,
    miss,
    pct,
    isEmpty: false,
    isLowN: eligible < CLEAN_LOW_N,
  }
}
