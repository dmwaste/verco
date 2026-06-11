/**
 * Closure-status decision for the admin Collection Dates "Open" column.
 *
 * A collection date can be closed for different reasons, and staff need to
 * tell them apart (VER-221: a WA public holiday closure looked identical to an
 * admin-toggled or capacity closure, generating confused support tickets).
 * VER-259 (BR-0018/BR-0019) extended the decision beyond `is_open`: the T-3
 * hard-close cron sets `locked_closed` (never `is_open`), past dates are never
 * locked by the cron at all, and per-bucket capacity closure lives on the
 * pool-merged `effectiveCapacity()` flags.
 *
 * Decision inputs → outcome:
 *
 *   isPast ─────────────┐
 *   lockedClosed ───────┤                ┌─ null      → 'open'    (green dot)
 *   !isOpen ────────────┼─ closureReason ┤
 *   allBucketsClosed ───┘   (precedence) └─ reason ─┬─ holiday? → 'holiday' (amber pill)
 *                                                   └─ else    → 'closed'  (grey dot + reason pill)
 *
 * closureReason is THE single decision path; closureStatus derives from it so
 * the dot and the reason pill can never disagree. Precedence:
 * past > locked > manual > capacity.
 *
 * The holiday name is resolved at read time against the `public_holiday`
 * table (already client-readable, already in the generated types). The caller
 * passes an ISO-date → holiday-name map built from that query. The amber pill
 * wins for ANY closed date (including past ones) — grey row styling already
 * signals past-ness; the pill's job is explaining WHY.
 */
export type ClosureStatus = 'open' | 'holiday' | 'closed'

export type ClosureReason = 'past' | 'locked' | 'manual' | 'capacity'

export interface ClosureInput {
  /** collection_date.is_open — the admin manual flag */
  isOpen: boolean
  /** collection_date.locked_closed — T-3 hard-close cron, sticky */
  lockedClosed: boolean
  /** date < today, computed with the AWST clock (awstDateFromUtc) */
  isPast: boolean
  /** AND of the three pool-merged effectiveCapacity *_is_closed flags */
  allBucketsClosed: boolean
  /** ISO date, for the holiday lookup */
  date: string
}

const reason = (pill: string, why: string) => ({ pill, why, title: `Closed — ${why}` })

/** Pill + tooltip copy per reason — a pinned design contract (VER-259 D-F4). */
export const CLOSURE_REASON: Record<
  ClosureReason,
  { pill: string; why: string; title: string }
> = {
  past: reason('Past', 'date has passed'),
  locked: reason('T-3 lock', 'bookings locked at the T-3 cutoff'),
  manual: reason('Admin closed', 'set closed by an administrator'),
  capacity: reason('Full', 'all capacity exhausted'),
}

/** The single closure decision. `null` means the date is genuinely open. */
export function closureReason(input: ClosureInput): ClosureReason | null {
  if (input.isPast) return 'past'
  if (input.lockedClosed) return 'locked'
  if (!input.isOpen) return 'manual'
  if (input.allBucketsClosed) return 'capacity'
  return null
}

export function closureStatus(
  input: ClosureInput,
  holidayNames: ReadonlyMap<string, string>,
): ClosureStatus {
  if (closureReason(input) === null) return 'open'
  if (holidayNames.has(input.date)) return 'holiday'
  return 'closed'
}
