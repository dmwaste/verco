import { describe, it, expect } from 'vitest'
import { resolveLatestRefund, shouldAutoApproveRefund } from '@/lib/payments/refund-auto-approve'

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

// The webhook PAYLOAD shape follows the endpoint's pinned Stripe API version,
// NOT the SDK's. On API >= 2022-11-15 the embedded `charge.refunds` list is
// omitted, so the backstop must fall back to a fetch — otherwise it reads a
// null amount and silently parks every direct-in-Stripe refund Pending (#387.2
// observability follow-up).
describe('resolveLatestRefund', () => {
  it('returns the embedded refund without fetching when the webhook includes it', async () => {
    let fetched = false
    const embedded = { id: 're_embed', amount: 5000 }
    const result = await resolveLatestRefund(embedded, async () => {
      fetched = true
      return null
    })
    expect(result).toBe(embedded)
    expect(fetched).toBe(false) // the embed is authoritative — no needless API call
  })

  it('fetches from Stripe when the embedded refunds list is absent (modern-pin payloads)', async () => {
    const fetchedRefund = { id: 're_fetched', amount: 2000 }
    const result = await resolveLatestRefund(undefined, async () => fetchedRefund)
    expect(result).toBe(fetchedRefund)
  })

  it('returns null when the embed is absent and the fetch finds no refund', async () => {
    // Genuine anomaly (charge.refunded fired but no refund resolvable) — the
    // caller parks Pending AND emits a Sentry warning rather than settling blind.
    const result = await resolveLatestRefund(undefined, async () => null)
    expect(result).toBeNull()
  })
})
