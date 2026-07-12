/**
 * Every `refund_request` row is auto-raised by a state change that has ALREADY
 * been applied — there is no discretionary "issue an arbitrary refund" path:
 *
 *   - a staff cancellation of a paid booking       (admin/bookings/[id]/actions.ts)
 *   - a staff quantity reduction on a paid booking (admin/bookings/[id]/actions.ts)
 *   - an NCN contractor-fault resolution           (admin/non-conformance/[id]/actions.ts)
 *   - an NP  contractor-fault resolution           (admin/nothing-presented/[id]/actions.ts)
 *   - a RESIDENT self-cancel of a paid booking     ((public)/booking/[ref]/actions.ts)
 *
 * Because the state change is already committed, the `amount_cents` is genuinely
 * owed to the resident, and rejecting the request is irreversible — there is no
 * re-raise path and the resident is never notified.
 *
 * `REFUND_REASONS` is the SINGLE SOURCE OF TRUTH for the `reason` string. The
 * writers import it to SET the reason; the admin refunds table imports
 * `isAutoRaised`/`autoRaisedContext` to CLASSIFY it. Sharing the constant means
 * the writer and reader can never drift. If a new refund path is added, register
 * its reason here or it will not be flagged as owed on the Refunds page.
 */
export const REFUND_REASONS = {
  staffCancellation: 'Booking cancelled by staff',
  quantityReduction: 'Booking quantity reduced by staff',
  ncnContractorFault: 'Contractor fault — NCN resolution',
  npContractorFault: 'Contractor fault — Nothing Presented resolution',
  residentCancellation: 'Booking cancelled by resident',
} as const

export type RefundReason = (typeof REFUND_REASONS)[keyof typeof REFUND_REASONS]

const AUTO_RAISED_REASONS: ReadonlySet<string> = new Set(Object.values(REFUND_REASONS))

/**
 * True when the refund was auto-raised by an already-applied state change, i.e.
 * the amount is owed. Exact-match only — a partial/superstring reason is treated
 * as unknown so a discretionary row can never be mistaken for owed money.
 */
export function isAutoRaised(reason: string | null | undefined): boolean {
  return reason != null && AUTO_RAISED_REASONS.has(reason)
}

/**
 * Plain-language phrase describing what already happened, for the reject-confirm
 * dialog: "This booking was already <phrase>." Returns null for unknown reasons
 * so the dialog falls back to generic copy.
 */
export function autoRaisedContext(reason: string | null | undefined): string | null {
  switch (reason) {
    case REFUND_REASONS.staffCancellation:
      return 'cancelled by staff'
    case REFUND_REASONS.quantityReduction:
      return 'reduced by staff'
    case REFUND_REASONS.ncnContractorFault:
      return 'resolved as contractor fault on a non-conformance notice'
    case REFUND_REASONS.npContractorFault:
      return 'resolved as contractor fault on a nothing-presented report'
    case REFUND_REASONS.residentCancellation:
      return 'cancelled by the resident'
    default:
      return null
  }
}
