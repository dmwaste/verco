import { describe, it, expect } from 'vitest'
import { refundStateToNotificationStatus } from '@/lib/refunds/notification-status'

// The single mapping from orchestrateRefund's outcome to the resident-facing
// refund_status the notification templates understand. Shared by all four
// refund sites (cancel, quantity reduction, NCN, NP) so they can never drift.
describe('refundStateToNotificationStatus', () => {
  it("maps 'initiated' (Stripe refund fired) to 'processed'", () => {
    expect(refundStateToNotificationStatus('initiated')).toBe('processed')
  })

  it("maps 'queued' (Pending row awaits admin approval) to 'pending_review'", () => {
    expect(refundStateToNotificationStatus('queued')).toBe('pending_review')
  })

  it("maps 'none' (nothing owed) to undefined — no refund line", () => {
    expect(refundStateToNotificationStatus('none')).toBeUndefined()
  })

  it("maps 'failed' (no Pending row exists) to undefined — never claim a refund is coming", () => {
    expect(refundStateToNotificationStatus('failed')).toBeUndefined()
  })
})
