/**
 * Server-side staged go-live gate (WS-A / VER-269) — fail CLOSED.
 *
 * Mirror pair with src/lib/booking/area-gate-server.ts, kept in sync by
 * scripts/sync-mirrors.sh (_shared/ is the source of truth). The create-booking
 * Edge Function uses this for an early, clear 403 before the capacity RPC.
 *
 * Unlike the client helper isAreaBookable (fail-OPEN, UX-only), this rejects
 * anything not explicitly active: a missing/null flag is treated as
 * not-bookable. The durable enforcement lives in
 * create_booking_with_capacity_check (which fails closed for every caller) and
 * the booking_resident_insert RLS policy; this helper keeps the resident path's
 * rejection fast and specific.
 */
export function isAreaBookableServer(
  area: { is_active: boolean | null } | null | undefined
): boolean {
  return area?.is_active === true
}
