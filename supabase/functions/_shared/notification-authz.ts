import type { NotificationDispatchInput } from './templates/types.ts'

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
