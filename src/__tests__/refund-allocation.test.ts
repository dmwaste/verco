import { describe, it, expect } from 'vitest'
import { allocateRefund, refundShortfallCents } from '@/lib/payments/refund-allocation'

// PR-B0: once a booking can carry >1 paid booking_payment (after PR-B1's delta
// charge), a refund must be spread across the charges — process-refund's old
// `.single()` + single stripe.refunds.create breaks. allocateRefund is the pure
// core: spread an amount across the booking's paid charges NEWEST-first, each
// capped by that charge's Stripe-remaining refundable (amount − amount_refunded).
// Single-charge (today's only case) must reduce to exactly one full refund.

const charge = (id: string, remainingCents: number) => ({
  bookingPaymentId: `bp-${id}`,
  stripeChargeId: `ch_${id}`,
  remainingCents,
})

describe('allocateRefund — single charge (current behaviour, must not regress)', () => {
  it('refunds the full amount against the one charge when it fits', () => {
    expect(allocateRefund(5000, [charge('A', 10000)])).toEqual([
      { bookingPaymentId: 'bp-A', stripeChargeId: 'ch_A', amountCents: 5000 },
    ])
  })

  it('caps at the charge remaining when the amount exceeds it (shortfall surfaced separately)', () => {
    const lines = allocateRefund(12000, [charge('A', 10000)])
    expect(lines).toEqual([{ bookingPaymentId: 'bp-A', stripeChargeId: 'ch_A', amountCents: 10000 }])
    expect(refundShortfallCents(12000, lines)).toBe(2000)
  })
})

describe('allocateRefund — multi charge (dormant until PR-B1)', () => {
  it('takes it all from the newest charge when it fits there', () => {
    // newest first: B ($50) then A ($100). Refund $40 → all from B.
    expect(allocateRefund(4000, [charge('B', 5000), charge('A', 10000)])).toEqual([
      { bookingPaymentId: 'bp-B', stripeChargeId: 'ch_B', amountCents: 4000 },
    ])
  })

  it('spans charges newest-first: fills the newest, then the remainder from the older', () => {
    // Refund $120: $50 from newest B, $70 from A.
    expect(allocateRefund(12000, [charge('B', 5000), charge('A', 10000)])).toEqual([
      { bookingPaymentId: 'bp-B', stripeChargeId: 'ch_B', amountCents: 5000 },
      { bookingPaymentId: 'bp-A', stripeChargeId: 'ch_A', amountCents: 7000 },
    ])
  })

  it('a full refund (amount = total remaining) refunds every charge in full', () => {
    const lines = allocateRefund(15000, [charge('B', 5000), charge('A', 10000)])
    expect(lines).toEqual([
      { bookingPaymentId: 'bp-B', stripeChargeId: 'ch_B', amountCents: 5000 },
      { bookingPaymentId: 'bp-A', stripeChargeId: 'ch_A', amountCents: 10000 },
    ])
    expect(refundShortfallCents(15000, lines)).toBe(0)
  })

  it('skips charges with zero remaining (already fully refunded)', () => {
    expect(allocateRefund(3000, [charge('B', 0), charge('A', 10000)])).toEqual([
      { bookingPaymentId: 'bp-A', stripeChargeId: 'ch_A', amountCents: 3000 },
    ])
  })
})

describe('allocateRefund — degenerate inputs', () => {
  it('zero amount → no refund lines', () => {
    expect(allocateRefund(0, [charge('A', 10000)])).toEqual([])
  })
  it('no charges → no lines and the whole amount is a shortfall', () => {
    const lines = allocateRefund(5000, [])
    expect(lines).toEqual([])
    expect(refundShortfallCents(5000, lines)).toBe(5000)
  })
})
