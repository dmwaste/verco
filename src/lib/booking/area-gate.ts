/**
 * Staged go-live gate (WS-A / VER-269).
 *
 * A collection area is only bookable on the new system when its `is_active`
 * flag is true. The flag drives WMRC's phased rollout: held-back councils
 * (and EAS until its Stage-2 migration) have `is_active = false` and resolve
 * to a "not yet available" message instead of a booking.
 *
 * Client-side this fails OPEN — only an explicit `false` blocks, so a missing
 * area embed never hard-blocks a resident. The `create-booking` Edge Function
 * is the real enforcement and fails CLOSED (rejects anything not active).
 */
export function isAreaBookable(
  area: { is_active: boolean } | null | undefined
): boolean {
  return area?.is_active !== false
}
