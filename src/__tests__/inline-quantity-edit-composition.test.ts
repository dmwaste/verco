import { describe, it, expect } from 'vitest'
import { mayKeepClosedHeldDate } from '@/lib/booking/edit-guard'
import { evaluateQuantityEdit } from '@/lib/booking/quantity-edit-decision'

/**
 * Interaction between #382 (a contractor may KEEP a booking's own held date
 * after it has been admin-closed — the create-booking `is_open` waiver) and #380
 * (the inline quantity editor). Both live in the same `create-booking` `replaces`
 * branch. A contractor reducing quantity on a booking whose held date is now
 * admin-closed must work END-TO-END:
 *   1. the is_open waiver fires — the editor never changes the date, so the
 *      target date IS the booking's held date, and
 *   2. the reduction applies with a refund.
 *
 * The EF has no Deno unit harness (this repo tests EF logic via its extracted
 * pure functions), so this pins the composition at the two pure seams the EF
 * calls in sequence.
 */
describe('inline quantity edit × closed-held-date waiver (composition)', () => {
  const HELD = 'held-date-uuid'
  const BOOKING = 'booking-uuid'

  it('contractor reducing a paid booking on its now-closed held date: waiver true AND apply-refund', () => {
    // Step 1 — #382: the editor passes the booking's current (held) date
    // unchanged, so targetDateId === a held date → waiver applies for contractors.
    for (const role of ['contractor-admin', 'contractor-staff']) {
      expect(
        mayKeepClosedHeldDate({ role, replaces: BOOKING, targetDateId: HELD, heldDateIds: [HELD] }),
      ).toBe(true)
    }
    // Step 2 — #380: paid $100 → $50 reduction, no drift → apply + refund $50,
    // same date throughout.
    expect(
      evaluateQuantityEdit({ baselineTotalCents: 10000, newTotalCents: 5000, collectedCents: 10000 }),
    ).toEqual({ kind: 'apply', refundOwedCents: 5000 })
  })

  it('client-tier admin does NOT get the closed-date waiver (contractor-only), so the edit is refused upstream', () => {
    expect(
      mayKeepClosedHeldDate({ role: 'client-admin', replaces: BOOKING, targetDateId: HELD, heldDateIds: [HELD] }),
    ).toBe(false)
  })
})
