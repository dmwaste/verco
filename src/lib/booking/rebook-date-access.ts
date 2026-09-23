/**
 * Which collection dates a staff user may rebook a non-conformance (or
 * nothing-presented) booking onto.
 *
 * WMRC asked for this before the 01/10/2026 Verge Valet cutover: when a
 * property has a non-conformance, they need to arrange the ad-hoc redo inside
 * the 3-day window "if spots are available". Until now every role — including
 * contractor-admin — was refused, because the rebook gate reads
 * `<bucket>_is_closed`, and the T-3 lock sets that flag.
 *
 * The rule:
 *   * It must be before **3:00pm AWST the day before** — WMRC's published
 *     cut-off, and the practical one: crews take their routes at 8pm.
 *   * The date must be OPEN. A public holiday or an admin-closed date stays
 *     closed — no crew runs, so the redo would strand. (A contractor-admin who
 *     genuinely needs one of those still has the admin date override, ADR 0014.)
 *   * A closure caused ONLY by the T-3 lock is allowed.
 *   * Every capacity bucket the booking's items occupy must have room. This is
 *     the "if spots are available" half, and it is why the lock relaxation is
 *     safe: it opens the window, never the ceiling.
 *
 * `<bucket>_is_closed` is `locked_closed OR (units_booked >= capacity_limit)`
 * (migration 20260518005937), so the flag alone cannot tell "locked" from
 * "full" — hence the raw counters below.
 *
 * Pooled areas (the MOS/COT/PEP/FRE-N crew shares one counter) keep their real
 * numbers on `collection_date_pool`; the caller passes the POOL's row for those
 * areas. `collection_date`'s own counters are inert there — a pool member reads
 * a capacity limit of 0 — so judging a pooled date on its own row would refuse
 * every date.
 */

/** Capacity bucket codes, matching `category.code`. */
export type BucketCode = 'bulk' | 'anc' | 'id'

export interface BucketState {
  is_closed: boolean
  capacity_limit: number
  units_booked: number
}

export interface RebookDateGate {
  /** The collection date, `YYYY-MM-DD` (AWST calendar date). */
  date: string
  /** The AREA's own flag, even for a pooled date — that's where a holiday lands. */
  is_open: boolean
  /** Closed by the T-3 lock. From the pool's row for a pooled area. */
  locked_closed: boolean
  /** Bucket counters. From the pool's row for a pooled area. */
  buckets: Record<BucketCode, BucketState>
}

export interface RebookDateVerdict {
  bookable: boolean
  /** Why not — for the staff-facing message. Null when bookable. */
  reason: 'closed' | 'full' | 'past-cutoff' | null
  /** True when the only thing standing in the way was the T-3 lock. */
  insideLockWindow: boolean
}

/**
 * 3:00pm AWST the day before collection, as an instant. WA has no daylight
 * saving, so +08:00 is exact and 3:00pm AWST is 07:00 UTC. Built with
 * `Date.UTC` so it does not depend on the server's timezone — `Date#setHours`
 * is wrong on the UTC production box (see cancellation-cutoff.ts).
 *
 * This is WMRC's published cut-off. It only ever bites on a next-day redo: for
 * anything further out we are already before it.
 */
export function rebookCutoff(collectionDate: string): Date {
  const [y, m, d] = collectionDate.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d - 1, 7, 0, 0, 0))
}

/** True once the 3:00pm-AWST-day-before cut-off has passed for that date. */
export function isPastRebookCutoff(collectionDate: string, now: Date = new Date()): boolean {
  return now.getTime() >= rebookCutoff(collectionDate).getTime()
}

/**
 * Decide one date for one booking. `requiredBuckets` are the category codes of
 * the items being cloned (a green-waste-only NCN needs 'bulk' capacity only,
 * since Green sits in the Bulk category — the codes come straight from
 * `service.category.code`).
 */
export function checkRebookDate(
  gate: RebookDateGate,
  requiredBuckets: readonly string[],
  now: Date = new Date(),
): RebookDateVerdict {
  const insideLockWindow = gate.locked_closed
  // WMRC's 3:00pm cut-off. Without it a redo could be created for tomorrow at
  // 9pm — after the crews took their routes at 8pm — and reach OptimoRoute on
  // the next hourly push with nobody having told the driver.
  if (isPastRebookCutoff(gate.date, now)) {
    return { bookable: false, reason: 'past-cutoff', insideLockWindow }
  }
  if (!gate.is_open) return { bookable: false, reason: 'closed', insideLockWindow }

  for (const code of requiredBuckets) {
    const bucket = gate.buckets[code as BucketCode]
    // An unknown or unconfigured bucket is a refusal, not a free pass.
    if (!bucket) return { bookable: false, reason: 'closed', insideLockWindow }
    if (bucket.units_booked >= bucket.capacity_limit) {
      return { bookable: false, reason: 'full', insideLockWindow }
    }
    // Closed for a reason other than the lock (an admin closing one bucket).
    if (bucket.is_closed && !gate.locked_closed) {
      return { bookable: false, reason: 'closed', insideLockWindow }
    }
  }

  return { bookable: true, reason: null, insideLockWindow }
}

/** Convenience wrapper for callers that only need the yes/no. */
export function isRebookDateBookable(
  gate: RebookDateGate,
  requiredBuckets: readonly string[],
  now: Date = new Date(),
): boolean {
  return checkRebookDate(gate, requiredBuckets, now).bookable
}

/** Build the bucket map from a `collection_date` or `collection_date_pool` row. */
export function bucketsFromRow(row: {
  bulk_is_closed: boolean
  bulk_capacity_limit: number
  bulk_units_booked: number
  anc_is_closed: boolean
  anc_capacity_limit: number
  anc_units_booked: number
  id_is_closed: boolean
  id_capacity_limit: number
  id_units_booked: number
}): Record<BucketCode, BucketState> {
  return {
    bulk: {
      is_closed: row.bulk_is_closed,
      capacity_limit: row.bulk_capacity_limit,
      units_booked: row.bulk_units_booked,
    },
    anc: {
      is_closed: row.anc_is_closed,
      capacity_limit: row.anc_capacity_limit,
      units_booked: row.anc_units_booked,
    },
    id: {
      is_closed: row.id_is_closed,
      capacity_limit: row.id_capacity_limit,
      units_booked: row.id_units_booked,
    },
  }
}
