/**
 * Client-side property eligibility gate.
 *
 * `eligible_properties.is_eligible = false` marks parcels an admin has retired
 * from service (e.g. a pre-subdivision parent lot, or a tip-pass-in-lieu
 * property). They still resolve in the address lookup, so the /book flow shows
 * a friendly "not eligible" message instead of "Property found!".
 *
 * Client-side this fails OPEN — only an explicit `false` blocks, so a row
 * missing the flag never hard-blocks a resident. The `create-booking` Edge
 * Function, the capacity RPCs, and the booking_resident_insert RLS policy are
 * the real enforcement and fail CLOSED.
 */
export function isPropertyBookable(
  property: { is_eligible: boolean } | null | undefined
): boolean {
  return property?.is_eligible !== false
}
