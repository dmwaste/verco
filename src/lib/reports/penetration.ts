/**
 * PENETRATION — Property Penetration (VER-179 §3.9).
 *
 * Insight card (no pass/fail, directional only): what share of a client's
 * eligible properties have ever been booked.
 *
 *   pct = 100 × booked / eligible
 *
 * Pure + deterministic: no Supabase imports, no network, no wall-clock reads.
 * The caller (reports-client) holds the two scalars itself — they come from the
 * `get_property_penetration` RPC (`COUNT(DISTINCT booking.property_id)` over the
 * numerator, `COUNT(*)` over the `eligible_properties ⋈ collection_area` join
 * for the denominator). This fn turns those scalars into the render shape:
 * a percentage, a human-readable display string, and the empty / low-n flags.
 *
 * Because the caller already holds `booked`/`eligible`, this fn deliberately
 * returns `display` + flags only (not the raw scalars).
 *
 * Render states (spec §3.9):
 *   - empty   (eligible ≤ 0 / not a finite count): "No eligible properties
 *             imported" — nothing to measure against.
 *   - low-n   (0 < booked < PENETRATION_LOW_N — the normal pre-go-live state,
 *             ~0.015% today): raw fraction "16 / 107,281 properties booked",
 *             % headline suppressed (`pct = null`).
 *   - at-n    (booked ≥ PENETRATION_LOW_N): percentage; `display` is the
 *             percentage string.
 *
 * As an insight card it is NEVER coloured pass/fail — there is no target.
 *
 * Defensive against dirty RPC scalars: counts are floored, `booked` is clamped
 * to `[0, eligible]` (known duplicate eligible imports — PR #182/#183 — and any
 * stray over-count can't push the rate above 100% or negative), and a
 * non-finite / non-positive `eligible` reads as empty rather than dividing by
 * zero or NaN.
 */

/**
 * Minimum distinct-booked sample before a percentage headline is shown.
 * Below this the card shows the raw fraction "booked / eligible" (spec §3.9).
 */
export const PENETRATION_LOW_N = 25

export interface PenetrationInput {
  /** Distinct eligible properties with at least one booking (the numerator). */
  booked: number
  /** Total eligible properties for the client/area (the denominator). */
  eligible: number
  /** Override the low-n threshold (defaults to PENETRATION_LOW_N). Tunable/testable. */
  lowNThreshold?: number
}

export interface PenetrationResult {
  /** Penetration % (0–100), or null when empty or low-n (% headline suppressed). */
  pct: number | null
  /**
   * Render string: the "No eligible properties imported" notice when empty, the
   * raw "booked / eligible properties booked" fraction when low-n, or the
   * percentage string when at-n.
   */
  display: string
  /** True when 0 < booked < threshold — show the raw fraction, no %. */
  isLowN: boolean
  /** True when there is no valid eligible denominator (≤ 0 / non-finite). */
  isEmpty: boolean
}

const EMPTY_DISPLAY = 'No eligible properties imported'

/** Floor a count to a non-negative integer; non-finite → 0. */
function toCount(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.floor(n))
}

export function computePenetration(input: PenetrationInput): PenetrationResult {
  const threshold = input?.lowNThreshold ?? PENETRATION_LOW_N

  // Denominator must be a finite, positive count or there is nothing to measure.
  const eligibleRaw = input?.eligible
  if (!Number.isFinite(eligibleRaw) || eligibleRaw <= 0) {
    return { pct: null, display: EMPTY_DISPLAY, isLowN: false, isEmpty: true }
  }

  const eligible = toCount(eligibleRaw)
  // Clamp booked to [0, eligible] so duplicate/over-counts can't exceed 100%.
  const booked = Math.min(toCount(input?.booked), eligible)

  if (booked < threshold) {
    return {
      pct: null,
      display: `${booked.toLocaleString('en-AU')} / ${eligible.toLocaleString('en-AU')} properties booked`,
      isLowN: true,
      isEmpty: false,
    }
  }

  const pct = (booked / eligible) * 100
  return {
    pct,
    display: `${pct.toFixed(2)}%`,
    isLowN: false,
    isEmpty: false,
  }
}
