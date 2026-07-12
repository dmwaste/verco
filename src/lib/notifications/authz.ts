import type { NotificationDispatchInput } from './templates/types'

/**
 * Tenant-scope authorization for the `send-notification` Edge Function.
 *
 * ## Why this exists
 *
 * The EF accepts two auth modes (see send-notification/index.ts): a service-role
 * bearer (EF→EF) or a valid user JWT whose `current_user_role()` is in a
 * permitted set. Regardless of mode, the dispatcher loads the target booking
 * with the SERVICE-ROLE client so it can read contact + branding across RLS.
 *
 * The role gate alone is therefore NOT a tenant gate: a `client-staff` user of
 * council A passes the role check, then the service-role load happily returns
 * council B's booking. With the `booking_updated` payload carrying a
 * caller-supplied `refund_cents`/`refund_status`, that let council A fire a
 * council-B-branded "a refund of $X has been processed" email — with a forged
 * amount — at any council-B resident. (Reported by the 11/07/2026 pre-cut
 * security review; same "staff-gate ≠ tenant-gate on service-role paths" class
 * as the admin-switcher P1 #275.)
 *
 * ## The gate
 *
 * For any non-service-role caller, require that the caller's OWN RLS can read
 * the target booking before dispatch. `callerCanReadBooking` performs a
 * user-scoped (RLS) read, so it reuses each role's existing `booking_*_select`
 * policy — resident by `contact_id`, staff by `client_id`, field/ranger by
 * `accessible_client_ids()` + `user_sub_client_allows_area()`. A cross-tenant
 * (or cross-sub-client) `booking_id` returns no row → deny. This is strictly
 * better than gating on `accessible_client_ids()` directly, which returns an
 * empty set for `resident`/`strata` and would wrongly deny resident-cancel.
 *
 * Pure orchestration with dependency injection (mirrors `dispatch()`), so the
 * whole decision is unit-testable in Node. Mirror of
 * src/lib/notifications/authz.ts (kept in sync by scripts/sync-mirrors.sh —
 * _shared is the source of truth).
 */

export type NotificationAuthzResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export interface NotificationAuthzDeps {
  /** True when the request bearer token equals the service-role key. */
  isServiceRole: boolean
  /**
   * Resolves the booking a payload targets. For `{ type, booking_id }` it is the
   * booking_id directly; for the resume `{ notification_log_id }` variant it maps
   * the log row → its booking_id (a service-role mapping read is fine — it only
   * chooses WHICH booking to gate, it does not grant access). Returns null when
   * the target cannot be resolved.
   */
  resolveBookingId: (input: NotificationDispatchInput) => Promise<string | null>
  /**
   * True iff the CALLER's own RLS can read the booking (user-scoped client).
   * This is the tenant/scope gate.
   */
  callerCanReadBooking: (bookingId: string) => Promise<boolean>
}

/**
 * Decide whether a caller may trigger a notification for the payload's booking.
 * Never throws — all outcomes are encoded in the returned Result. Denials carry
 * a 403 so the EF can distinguish "not allowed to act on this booking" from the
 * 401 "bad/absent credentials" the role gate returns.
 */
export async function authorizeNotificationDispatch(
  input: NotificationDispatchInput,
  deps: NotificationAuthzDeps
): Promise<NotificationAuthzResult> {
  // Service-role (EF→EF) callers are trusted server contexts — no I/O, no gate.
  if (deps.isServiceRole) {
    return { ok: true }
  }

  const bookingId = await deps.resolveBookingId(input)
  if (!bookingId) {
    return {
      ok: false,
      status: 403,
      error: 'Forbidden — notification target booking could not be resolved',
    }
  }

  const canRead = await deps.callerCanReadBooking(bookingId)
  if (!canRead) {
    return {
      ok: false,
      status: 403,
      error: 'Forbidden — booking is outside the caller’s tenant scope',
    }
  }

  return { ok: true }
}

/**
 * Shape-validate a parsed dispatch payload at the EF boundary. Returns a 400
 * Result for every malformed shape; `{ ok: true }` for a well-formed one.
 *
 * `NotificationDispatchInput` is a discriminated union: a fresh
 * `{ type, booking_id }` OR a resume `{ notification_log_id }`, never both. The
 * HYBRID shape is rejected because it is a cross-tenant gate bypass: the tenant
 * gate resolves `booking_id`-first and would authorize the caller's OWN
 * booking, while `dispatch()` resumes `notification_log_id`-first and acts on
 * the VICTIM's log row. Rejecting the ambiguous shape closes it at the boundary.
 *
 * Pure (no I/O) so the EF's input contract is unit-testable in Node.
 */
export function validateDispatchInputShape(
  input: unknown
): NotificationAuthzResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, status: 400, error: 'Payload must be a JSON object' }
  }
  const hasLog = 'notification_log_id' in input
  const hasFresh = 'type' in input && 'booking_id' in input
  if (!hasLog && !hasFresh) {
    return {
      ok: false,
      status: 400,
      error:
        'Payload must include either {type, booking_id} or {notification_log_id}',
    }
  }
  if (hasLog && ('type' in input || 'booking_id' in input)) {
    return {
      ok: false,
      status: 400,
      error:
        'Payload must be either {type, booking_id} or {notification_log_id}, not both',
    }
  }
  return { ok: true }
}

/**
 * Resolve the booking a payload targets, mirroring `dispatch()`'s resume-first
 * precedence: a `notification_log_id` maps to its booking (via the injected
 * `loadLogBooking`) BEFORE any `booking_id` is consulted, so the tenant gate
 * authorizes the SAME booking `dispatch()` will act on. Returns null when the
 * target cannot be resolved.
 *
 * `loadLogBooking` is injected (a service-role mapping read in the EF) so this
 * decision stays pure and unit-testable.
 */
export async function resolveTargetBookingId(
  input: NotificationDispatchInput,
  loadLogBooking: (logId: string) => Promise<string | null>
): Promise<string | null> {
  if ('notification_log_id' in input && input.notification_log_id) {
    return await loadLogBooking(input.notification_log_id)
  }
  if ('booking_id' in input && input.booking_id) {
    return input.booking_id
  }
  return null
}
