/**
 * Office correction of a crew's closeout (ADR 0030) — UI/action mirror of the
 * `correct_stop_outcome` RPC's gates. The RPC is the enforcement; these only
 * decide whether the "Correct outcome" button shows and which resident email
 * the server action sends afterwards.
 */

export const CORRECTABLE_OUTCOMES = ['Completed', 'Non-conformance', 'Nothing Presented'] as const
export type CorrectableOutcome = (typeof CORRECTABLE_OUTCOMES)[number]

/** Days after the stop's (dispatched) collection date a closeout stays correctable. */
export const CORRECTION_WINDOW_DAYS = 7

/** Booking statuses a correction is allowed on — Scheduled = a sibling pass still Pending. */
const CORRECTABLE_BOOKING_STATUSES: readonly string[] = ['Scheduled', ...CORRECTABLE_OUTCOMES]

export function isCorrectableOutcome(status: string): status is CorrectableOutcome {
  return (CORRECTABLE_OUTCOMES as readonly string[]).includes(status)
}

/** Last AWST date (YYYY-MM-DD, inclusive) a closeout on `collectionDate` can be corrected. */
export function correctionDeadline(collectionDate: string): string {
  const d = new Date(`${collectionDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + CORRECTION_WINDOW_DAYS)
  return d.toISOString().slice(0, 10)
}

export function canCorrectStopOutcome(args: {
  role: string | null | undefined
  stopStatus: string
  bookingStatus: string
  /** The stop's collection date (YYYY-MM-DD) — never the booking's corrected date (ADR 0009). */
  collectionDate: string
  todayAwst: string
}): boolean {
  return (
    args.role === 'contractor-admin' &&
    isCorrectableOutcome(args.stopStatus) &&
    CORRECTABLE_BOOKING_STATUSES.includes(args.bookingStatus) &&
    args.todayAwst <= correctionDeadline(args.collectionDate)
  )
}

/** The resident email a correction TO `to` sends. */
export function correctionNotice(
  to: CorrectableOutcome,
): 'ncn_raised' | 'np_raised' | 'closeout_corrected' {
  if (to === 'Non-conformance') return 'ncn_raised'
  if (to === 'Nothing Presented') return 'np_raised'
  return 'closeout_corrected'
}

/** NCN ↔ NP: the resident already holds the other notice, so the new one says it replaces it. */
export function replacesEarlierNotice(from: CorrectableOutcome, to: CorrectableOutcome): boolean {
  return from !== 'Completed' && to !== 'Completed'
}
