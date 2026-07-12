import type { RefundOrchestrationState } from '@/lib/payments/orchestrate-refund'

/**
 * Map an `orchestrateRefund` outcome to the resident-facing `refund_status` the
 * notification templates understand — the SINGLE source of truth for that
 * mapping, shared by every refund site (cancel, quantity reduction, NCN
 * resolution, NP resolution) so their refund copy can never drift.
 *
 *   - `initiated` → `processed`       (Stripe refund already fired)
 *   - `queued`    → `pending_review`  (Pending row awaits admin approval)
 *   - `none` / `failed` → undefined   (no refund line — never claim a refund is
 *     coming when none was recorded)
 *
 * `undefined` deliberately collapses `none` and `failed`: a template refund line
 * would be a lie in both cases (nothing owed, or nothing recorded). Callers
 * surface `failed` to STAFF via the returned refund state, not to the resident.
 */
export function refundStateToNotificationStatus(
  state: RefundOrchestrationState,
): 'processed' | 'pending_review' | undefined {
  return state === 'initiated'
    ? 'processed'
    : state === 'queued'
      ? 'pending_review'
      : undefined
}
