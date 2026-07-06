import { isPastCancellationCutoff } from './cancellation-cutoff.ts'

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

export function evaluateEditGuard(input: EditGuardInput): EditGuardResult {
  if (!input.bookingExists) {
    return {
      ok: false,
      status: 403,
      error: 'Booking not found or you do not have permission to edit it.',
    }
  }

  const isStaff = input.role != null && STAFF_ROLES.includes(input.role)
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
