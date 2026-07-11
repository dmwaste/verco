/**
 * Money-safety decision for the inline admin quantity editor (issue #380 /
 * BR-0028). The `create-booking` Edge Function's in-place edit (`replaces`)
 * branch calls this with three server-computed cents figures to decide what a
 * quantity edit is allowed to do — WITHOUT trusting any client price (Red Line #1).
 *
 *   baselineTotalCents = calculatePrice(CURRENT persisted items, exclude self)
 *   newTotalCents      = calculatePrice(NEW items,               exclude self)
 *   collectedCents     = SUM(paid booking_payment) − SUM(Approved refund_request)
 *                        — the amount actually still held for this booking
 *
 * Both totals are computed with the SAME engine call under the SAME current FY
 * state, so `delta = newTotalCents - baselineTotalCents` is the drift-immune
 * marginal cost of THIS edit (other bookings' usage cancels in the subtraction).
 *
 * Rules (spec §3 v2, after adversarial money-safety review):
 *   1. DRIFT GUARD FIRST — `baseline != collected` means the booking's price has
 *      drifted from what was actually collected (an interim other booking, a
 *      council price change, etc.). The fair price is then ambiguous, so any
 *      automated refund/charge could be wrong → block, route to cancel & rebook.
 *   2. `delta > 0` — the edit increases what's owed. PR-A defers the Stripe
 *      charge-on-increase path to PR-B → block with the delta owed.
 *   3. `delta <= 0` — apply in place; the caller refunds `|delta|` via the
 *      existing refund machinery (mirrors `cancelBooking`).
 *
 * Pure + deterministic (no I/O) so the whole money decision is unit-testable.
 * Mirror of src/lib/booking/quantity-edit-decision.ts (kept in sync by
 * scripts/sync-mirrors.sh — _shared is the source of truth).
 */
export interface QuantityEditInput {
  /** calculatePrice(CURRENT persisted items, exclude self) — re-price of what's booked now. */
  baselineTotalCents: number
  /** calculatePrice(NEW items, exclude self) — same engine call, same FY state. */
  newTotalCents: number
  /**
   * SUM(paid booking_payment) − SUM(Approved refund_request) — the amount
   * actually still held. Netting approved refunds is load-bearing: passing
   * gross paid makes the drift guard wrongly block every edit after the first
   * refund (see the create-booking EF's collectedCents computation).
   */
  collectedCents: number
}

export type QuantityEditDecision =
  | { kind: 'apply'; refundOwedCents: number }
  | { kind: 'block_requires_payment'; deltaCents: number }
  | { kind: 'block_drift'; baselineTotalCents: number; collectedCents: number }

export function evaluateQuantityEdit(input: QuantityEditInput): QuantityEditDecision {
  const { baselineTotalCents, newTotalCents, collectedCents } = input

  if (baselineTotalCents !== collectedCents) {
    return { kind: 'block_drift', baselineTotalCents, collectedCents }
  }

  const deltaCents = newTotalCents - baselineTotalCents
  if (deltaCents > 0) {
    return { kind: 'block_requires_payment', deltaCents }
  }

  // deltaCents <= 0 here. Guard the `< 0` case explicitly so a zero delta
  // returns a clean +0 (not the -0 that `-deltaCents` yields for delta === 0).
  return { kind: 'apply', refundOwedCents: deltaCents < 0 ? -deltaCents : 0 }
}
