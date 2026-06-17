/**
 * SELFSVC — Self-Service Rate (VER-179 §3.6).
 *
 * Pure + deterministic: no Supabase, no network, no wall-clock reads. Every
 * input is a stored booking row passed in; the result is fully unit-testable.
 *
 * Self-service = the share of in-scope bookings a resident created themselves,
 * over the in-scope bookings whose channel is actually KNOWN. The signal is the
 * immutable `booking.created_via` stamped at INSERT (CBSTAMP, §4.2): one of
 * `resident | admin | ranger | system`. Pre-CBSTAMP rows backfill to `'legacy'`
 * and brand-new rows that were never stamped read NULL — neither has a real
 * channel, so both are excluded from the denominator and reported separately as
 * `excludedLegacy`. Blending NULL/legacy rows into the denominator would
 * silently understate the rate, so the spec forbids it.
 *
 * In-scope = `type IN ('Residential','MUD') AND status <> 'Cancelled'`
 * (ID / call-back bookings and never-serviced cancellations are not resident
 * self-service bookings). The in-scope filter is applied first, so a Cancelled
 * legacy row never inflates `excludedLegacy`.
 */

/** Booking creation channels that are explicitly stamped (the known signal). */
export const STAMPED_CHANNELS = [
  'resident',
  'admin',
  'ranger',
  'system',
] as const

export type StampedChannel = (typeof STAMPED_CHANNELS)[number]

/** Booking types that are in scope for the self-service rate. */
const IN_SCOPE_TYPES = new Set(['Residential', 'MUD'])

/**
 * Low-n threshold for SELFSVC. Below this many stamped in-scope bookings the
 * card shows the raw fraction + "Building data" and never a coloured pass/fail
 * percentage. Exported so it is testable + tunable (spec §5.4: SELFSVC = 20).
 */
export const N_MIN = 20

const STAMPED_SET: ReadonlySet<string> = new Set(STAMPED_CHANNELS)

/** A booking row as far as the self-service calc cares (loose by design). */
export interface SelfServiceRow {
  /** Immutable channel stamped at INSERT; NULL/legacy/unknown ⇒ untracked. */
  created_via?: string | null
  /** `booking_type` value. */
  type?: string | null
  /** `booking_status` value. */
  status?: string | null
}

export interface SelfServiceResult {
  /** Stamped in-scope bookings — the denominator the rate is computed over. */
  inScope: number
  /** Stamped in-scope bookings with `created_via === 'resident'` — numerator. */
  selfServed: number
  /** `selfServed / inScope × 100`; null when the stamped denominator is 0. */
  pct: number | null
  /**
   * In-scope bookings whose channel is NOT known (NULL / 'legacy' / unknown
   * value). Reported for the "{x} earlier bookings excluded" footnote; never
   * folded into `inScope`.
   */
  excludedLegacy: number
  /** True when there are zero stamped in-scope bookings. */
  isEmpty: boolean
  /** True when `0 < inScope < nMin` — raw fraction, no coloured headline. */
  isLowN: boolean
}

export interface SelfServiceOptions {
  /** Override the low-n threshold (defaults to {@link N_MIN}). */
  nMin?: number
}

/**
 * Map a row's `created_via` to a known stamped channel, or `null` when the
 * channel is unknown (NULL, the 'legacy' backfill marker, an unexpected string,
 * or a non-string). A `null` result means the row must be excluded from the
 * self-service denominator and counted as `excludedLegacy`.
 */
export function classifyBookingChannel(row: {
  created_via?: string | null
}): StampedChannel | null {
  const value = row.created_via
  if (typeof value !== 'string') return null
  return STAMPED_SET.has(value) ? (value as StampedChannel) : null
}

/**
 * Compute the self-service rate over a set of booking rows.
 *
 * @param rows  booking rows (only `created_via` / `type` / `status` are read);
 *              a null/undefined array is treated as empty
 * @param opts  optional `{ nMin }` override for the low-n threshold
 */
export function computeSelfServiceRate(
  rows: readonly SelfServiceRow[],
  opts?: SelfServiceOptions,
): SelfServiceResult {
  const nMin = opts?.nMin ?? N_MIN

  let inScope = 0
  let selfServed = 0
  let excludedLegacy = 0

  for (const row of rows ?? []) {
    if (!isInScope(row)) continue

    const channel = classifyBookingChannel(row)
    if (channel === null) {
      excludedLegacy += 1
      continue
    }

    inScope += 1
    if (channel === 'resident') selfServed += 1
  }

  const isEmpty = inScope === 0
  return {
    inScope,
    selfServed,
    pct: isEmpty ? null : (selfServed / inScope) * 100,
    excludedLegacy,
    isEmpty,
    isLowN: inScope > 0 && inScope < nMin,
  }
}

/** In scope = Residential/MUD booking that is not Cancelled. */
function isInScope(row: SelfServiceRow): boolean {
  return (
    typeof row.type === 'string' &&
    IN_SCOPE_TYPES.has(row.type) &&
    row.status !== 'Cancelled'
  )
}
