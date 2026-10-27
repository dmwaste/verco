/**
 * Offered-service gate — fail CLOSED. A booking may only include services its
 * collection area offers (a service_rules row).
 *
 * Mirror pair with src/lib/booking/service-gate-server.ts, kept in sync by
 * scripts/sync-mirrors.sh (_shared/ is the source of truth). The create-booking
 * Edge Function uses this for an early, clear 400 before pricing.
 *
 * Why: pricing reads a missing rule as 0 free units at a $0 extra price, so an
 * un-offered service (e.g. a Mattress in Town of Cambridge, which offers none)
 * would book for $0 from a hand-crafted request. The resident UI only lists the
 * area's own rules, so this never fires for a real resident. The durable
 * enforcement is in the booking RPCs (create_booking_with_capacity_check,
 * update_booking_items_in_place, create_mud_booking_with_capacity_check —
 * migration 20261027030000); this keeps the rejection fast and specific.
 */

export const SERVICE_NOT_OFFERED_MESSAGE =
  "One or more of these services isn't offered in this collection area."

/**
 * The requested services the area doesn't offer, each named once. Pass the
 * booking's current quantities when editing: a service already on the booking
 * may be kept or reduced even if its rule has since been removed (a staff
 * reduction that owes a refund must still go through), but not added or
 * increased — the extra units would price at $0.
 */
export function unofferedServiceIds(
  requested: ReadonlyArray<{ service_id: string; quantity: number }>,
  offeredServiceIds: Iterable<string>,
  current: ReadonlyMap<string, number> = new Map(),
): string[] {
  const offered = new Set(offeredServiceIds)
  const quantityByService = new Map<string, number>()
  for (const r of requested) {
    quantityByService.set(r.service_id, (quantityByService.get(r.service_id) ?? 0) + r.quantity)
  }
  return [...quantityByService]
    .filter(([id, quantity]) => !offered.has(id) && quantity > (current.get(id) ?? 0))
    .map(([id]) => id)
}
