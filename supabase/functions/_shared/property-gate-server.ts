/**
 * Server-side property eligibility gate — fail CLOSED.
 *
 * Mirror pair with src/lib/booking/property-gate-server.ts, kept in sync by
 * scripts/sync-mirrors.sh (_shared/ is the source of truth). The create-booking
 * Edge Function uses this for an early, clear 403 before the capacity RPC.
 *
 * `eligible_properties.is_eligible = false` marks parcels an admin has retired
 * from service (e.g. a pre-subdivision parent lot like 16 Bolsover St, or a
 * tip-pass-in-lieu property). They still resolve in the address lookup, so the
 * booking path must reject them explicitly. Unlike the client helper
 * isPropertyBookable (fail-OPEN, UX-only), this rejects anything not explicitly
 * eligible. The durable enforcement lives in create_booking_with_capacity_check
 * / create_mud_booking_with_capacity_check (both fail closed for every caller)
 * and the booking_resident_insert RLS policy; this helper keeps the resident
 * path's rejection fast and specific.
 */
export function isPropertyEligibleServer(
  property: { is_eligible: boolean | null } | null | undefined
): boolean {
  return property?.is_eligible === true
}
