import { isPastCancellationCutoff } from './cancellation-cutoff'

/**
 * Authorisation + timing guard for the create-booking Edge Function's in-place
 * EDIT branch (`replaces` set). The EF calls the smart-diff RPC via the
 * SERVICE-ROLE client, which bypasses RLS — so nothing else protects the
 * client-supplied `replaces` booking id. This decision is the gate:
 *
 *  - Ownership (IDOR): the EF first fetches the replaced booking through the
 *    caller's RLS-scoped anon client. A guest guessing a UUID, or a staffer
 *    outside their client scope, gets NO row → `bookingExists: false` → 403.
 *    RLS is the ownership contract; we do not re-derive it here.
 *  - Cutoff: a resident cannot edit a booking whose collection is past the
 *    3:30pm-day-prior cutoff (run sheets / T-3 push are built). Staff are
 *    exempt — the admin edit surfaces permit post-cutoff / post-dispatch
 *    changes by role (see canEditCollectionDetails), so blocking them here
 *    would break a legitimate workflow.
 *
 * Pure + deterministic (no Supabase, no wall-clock read — `now` is injected) so
 * the whole decision is unit-testable. Mirror of src/lib/booking/edit-guard.ts.
 */
export type EditGuardResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export interface EditGuardInput {
  /** True iff the caller could SELECT the replaced booking under RLS. */
  bookingExists: boolean
  /** The booking's CURRENT collection date (ISO), for the cutoff check. */
  currentCollectionDate: string | null
  /** `current_user_role()` for the caller; null for anon/guest. */
  role: string | null
  /** Injected clock. */
  now: Date
}

// Staff roles exempt from the resident cancellation cutoff. Mirrors
// CREATOR_STAFF_ROLES / STAFF_ROLES; kept local because the mirror-sync sed
// only rewrites import extensions, not cross-directory paths, and
// classify-creator mirrors to a different src/lib subdirectory.
const STAFF_ROLES = [
  'contractor-admin',
  'contractor-staff',
  'client-admin',
  'client-staff',
]

// Roles permitted to EDIT a booking. RLS SELECT-access is necessary but not
// sufficient: `field` and `ranger` can SELECT bookings in their scope
// (booking_field_select) yet must never mutate them, so SELECT-visibility alone
// would over-permit. Residents (resident/strata) edit their own; staff edit
// on-behalf. Anyone else is rejected even if they could read the row.
const EDIT_ROLES = ['resident', 'strata', ...STAFF_ROLES]

export function evaluateEditGuard(input: EditGuardInput): EditGuardResult {
  if (!input.bookingExists) {
    return {
      ok: false,
      status: 403,
      error: 'Booking not found or you do not have permission to edit it.',
    }
  }

  if (input.role == null || !EDIT_ROLES.includes(input.role)) {
    return {
      ok: false,
      status: 403,
      error: 'You do not have permission to edit this booking.',
    }
  }

  const isStaff = STAFF_ROLES.includes(input.role)
  if (
    !isStaff &&
    input.currentCollectionDate &&
    isPastCancellationCutoff(input.currentCollectionDate, input.now)
  ) {
    return {
      ok: false,
      status: 403,
      error:
        'The change cutoff (3:30pm the day before collection) has passed; this booking can no longer be edited.',
    }
  }

  return { ok: true }
}

// Contractor (D&M) tier only — a subset of STAFF_ROLES. Inlined for the same
// mirror-sync reason as STAFF_ROLES above.
const CONTRACTOR_STAFF_ROLES = ['contractor-admin', 'contractor-staff']

/**
 * #378 — whether a contractor-tier actor may KEEP a booking's own held date that
 * has since been admin-closed (`is_open=false`), waiving the create-booking EF's
 * "collection date is open" guard for exactly that case.
 *
 * This is a RETAINED date on an in-place edit, not a NEW booking landing on a
 * closed slot, so re-validating `is_open` is wrong — the booking already occupies
 * that date. The waiver is deliberately narrow:
 *   - only on an edit (`replaces` set),
 *   - only contractor-tier (client-tier admins + residents excluded — they can't
 *     even surface a closed held date in the wizard, and are blocked here too),
 *   - only when the target IS the replaced booking's current held date, i.e.
 *     every one of its items already sits on `targetDateId`. A contractor MOVING
 *     to a different closed date is not keeping the held date and is not waived
 *     here (that path is the admin inline editor's server-side gate).
 *
 * `heldDateIds` is the replaced booking's item collection_date_ids, read through
 * the caller's RLS-scoped client — an empty set (unreadable / no items) blocks.
 */
export function mayKeepClosedHeldDate(input: {
  role: string | null
  replaces: string | null | undefined
  targetDateId: string
  heldDateIds: string[]
}): boolean {
  if (!input.replaces) return false
  if (input.role == null || !CONTRACTOR_STAFF_ROLES.includes(input.role)) return false
  return (
    input.heldDateIds.length > 0 &&
    input.heldDateIds.every((id) => id === input.targetDateId)
  )
}
