/**
 * Multi-charge refund allocation (PR-B0, #380).
 *
 * A booking can carry more than one `paid` booking_payment once PR-B1's
 * increase-delta charge lands (an original charge + a delta charge). A refund
 * (cancel, inline-reduction, NCN/NP, manual) must then be spread across those
 * charges — Stripe rejects a refund larger than a single charge's remaining
 * refundable (`amount − amount_refunded`). This is the pure allocation core:
 * spread `amountCents` NEWEST-charge-first, each capped by its remaining.
 *
 * NEWEST-first is deliberate: the delta charge (most recent) is refunded before
 * the original, matching "undo the most recent money movement first".
 *
 * Single-charge (the only case pre-PR-B1) reduces to exactly one full refund, so
 * process-refund's behaviour is unchanged for every booking that exists today.
 *
 * Pure + deterministic. Mirror of src/lib/payments/refund-allocation.ts (kept in
 * sync by scripts/sync-mirrors.sh — _shared is the source of truth).
 */
export interface RefundableCharge {
  bookingPaymentId: string
  stripeChargeId: string
  /** Stripe-remaining refundable for this charge = amount − amount_refunded. */
  remainingCents: number
}

export interface RefundAllocationLine {
  bookingPaymentId: string
  stripeChargeId: string
  amountCents: number
}

/**
 * Allocate `amountCents` across `chargesNewestFirst`, each line capped by that
 * charge's `remainingCents`. Charges must be pre-sorted newest-first. If the
 * charges can't cover the amount the shortfall is left unallocated — the caller
 * checks `refundShortfallCents` and surfaces it rather than silently under-refunding.
 */
export function allocateRefund(
  amountCents: number,
  chargesNewestFirst: RefundableCharge[],
): RefundAllocationLine[] {
  const lines: RefundAllocationLine[] = []
  let remaining = amountCents
  for (const c of chargesNewestFirst) {
    if (remaining <= 0) break
    const take = Math.min(remaining, c.remainingCents)
    if (take > 0) {
      lines.push({
        bookingPaymentId: c.bookingPaymentId,
        stripeChargeId: c.stripeChargeId,
        amountCents: take,
      })
      remaining -= take
    }
  }
  return lines
}

/** How much of `amountCents` the allocation could NOT cover (0 when fully allocated). */
export function refundShortfallCents(
  amountCents: number,
  lines: RefundAllocationLine[],
): number {
  const allocated = lines.reduce((sum, l) => sum + l.amountCents, 0)
  return Math.max(0, amountCents - allocated)
}
