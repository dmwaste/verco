import { describe, it, expect } from 'vitest'
import { shouldAutoApproveRefund } from '@/lib/payments/refund-auto-approve'

// Unit coverage for the stripe-webhook amount guard (#387.2). The backstop
// only auto-approves a Pending refund_request when the Stripe refund amount
// EXACTLY matches it — anything else is left Pending for manual reconciliation.

describe('shouldAutoApproveRefund', () => {
  it('auto-approves when the refund amount exactly matches the request', () => {
    expect(shouldAutoApproveRefund(5000, 5000)).toBe(true)
  })

  it('does NOT auto-approve when the amounts differ', () => {
    expect(shouldAutoApproveRefund(2000, 5000)).toBe(false)
  })

  it('does NOT auto-approve when the Stripe refund amount is unknown (null)', () => {
    // The webhook could not read latestRefund.amount — never settle a request
    // against a missing figure.
    expect(shouldAutoApproveRefund(null, 5000)).toBe(false)
  })

  it('documents oldest-Pending selection: a refund sized for a NEWER request does not settle the oldest', () => {
    // The webhook selects the OLDEST Pending refund_request (ORDER BY created_at
    // ASC). When a booking carries two Pending requests of different amounts
    // (e.g. a $50 full-cancel raised first, then a $20 quantity-reduction), a
    // Stripe refund actually sized for the newer $20 request is passed here
    // against the OLDER $50 one — it must NOT auto-approve, leaving both Pending
    // for a human to map correctly (precise charge→request linkage is PR-B1).
    const oldestPendingAmount = 5000 // the $50 full-cancel request, selected by the EF
    const refundForNewerRequest = 2000 // Stripe refund actually sized for the $20 reduction
    expect(shouldAutoApproveRefund(refundForNewerRequest, oldestPendingAmount)).toBe(false)
  })
})
