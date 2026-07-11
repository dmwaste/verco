import { describe, it, expect } from 'vitest'
import { evaluateQuantityEdit } from '@/lib/booking/quantity-edit-decision'

// evaluateQuantityEdit is the money-safety core of the inline admin quantity
// editor (issue #380 / BR-0028). It decides, from three server-computed cents
// figures, what an in-place quantity edit is allowed to do:
//
//   baselineTotalCents = calculatePrice(CURRENT persisted items, exclude self)
//   newTotalCents      = calculatePrice(NEW items,               exclude self)   // same engine call
//   collectedCents     = SUM(booking_payment.amount_cents WHERE status='paid')
//
//   delta = newTotalCents - baselineTotalCents      // drift-immune marginal cost
//
// Rules (spec §3 v2):
//   - DRIFT GUARD FIRST: baseline != collected → block (cancel & rebook). Under
//     drift the fair price is ambiguous, so any auto refund/charge could be wrong.
//   - delta > 0  → block (PR-A: increase into paid deferred to PR-B payment path).
//   - delta <= 0 → apply in place; refund |delta| via the existing refund machinery.

describe('evaluateQuantityEdit — apply (no money moved)', () => {
  it('free-quota change on a free booking (baseline=collected=0, delta=0) → apply, no refund', () => {
    const r = evaluateQuantityEdit({ baselineTotalCents: 0, newTotalCents: 0, collectedCents: 0 })
    expect(r).toEqual({ kind: 'apply', refundOwedCents: 0 })
  })

  it('same-total edit on a settled paid booking (baseline=collected, delta=0) → apply, no refund', () => {
    const r = evaluateQuantityEdit({ baselineTotalCents: 5000, newTotalCents: 5000, collectedCents: 5000 })
    expect(r).toEqual({ kind: 'apply', refundOwedCents: 0 })
  })
})

describe('evaluateQuantityEdit — apply with refund (reduction, no drift)', () => {
  it('paid → free reduction refunds the full paid amount', () => {
    // Booking paid $100 for 2 extra units; reduced so it becomes free-only.
    const r = evaluateQuantityEdit({ baselineTotalCents: 10000, newTotalCents: 0, collectedCents: 10000 })
    expect(r).toEqual({ kind: 'apply', refundOwedCents: 10000 })
  })

  it('paid → smaller-paid reduction refunds only the difference', () => {
    // Paid $100 (2 units @ $50); reduced to 1 paid unit ($50) → refund $50.
    const r = evaluateQuantityEdit({ baselineTotalCents: 10000, newTotalCents: 5000, collectedCents: 10000 })
    expect(r).toEqual({ kind: 'apply', refundOwedCents: 5000 })
  })
})

describe('evaluateQuantityEdit — block: increase requires payment (PR-B)', () => {
  it('free → paid increase on a clean free booking is blocked with the delta owed', () => {
    // Free booking (baseline=collected=0); increase adds a $50 paid unit.
    const r = evaluateQuantityEdit({ baselineTotalCents: 0, newTotalCents: 5000, collectedCents: 0 })
    expect(r).toEqual({ kind: 'block_requires_payment', deltaCents: 5000 })
  })

  it('paid → more-paid increase on a settled booking is blocked with the delta owed', () => {
    const r = evaluateQuantityEdit({ baselineTotalCents: 5000, newTotalCents: 10000, collectedCents: 5000 })
    expect(r).toEqual({ kind: 'block_requires_payment', deltaCents: 5000 })
  })
})

describe('evaluateQuantityEdit — block: price drift (baseline != collected)', () => {
  it('settled booking whose current items now re-price higher than collected → block_drift', () => {
    // An interim second booking consumed the free tier: current items re-price
    // to $200 but only $100 was collected. Refund/charge would be wrong → block.
    const r = evaluateQuantityEdit({ baselineTotalCents: 20000, newTotalCents: 15000, collectedCents: 10000 })
    expect(r).toEqual({ kind: 'block_drift', baselineTotalCents: 20000, collectedCents: 10000 })
  })

  it('free booking whose current items now re-price as paid (baseline>0, collected=0) → block_drift', () => {
    const r = evaluateQuantityEdit({ baselineTotalCents: 5000, newTotalCents: 5000, collectedCents: 0 })
    expect(r).toEqual({ kind: 'block_drift', baselineTotalCents: 5000, collectedCents: 0 })
  })

  it('drift guard takes precedence over the requires-payment check', () => {
    // baseline != collected AND delta > 0 → drift wins (block_drift, not payment).
    const r = evaluateQuantityEdit({ baselineTotalCents: 8000, newTotalCents: 12000, collectedCents: 5000 })
    expect(r.kind).toBe('block_drift')
  })
})
