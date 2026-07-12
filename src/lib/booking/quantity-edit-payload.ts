/**
 * Inline quantity editor (#380) → create-booking EF payload.
 *
 * Produces the two item sets the EF needs for a #387.1-safe edit:
 *   • `items`         — the admin's TARGET quantities (editor draft, falling back
 *                       to the original for any service the admin didn't touch).
 *   • `expectedItems` — the ORIGINAL quantities that were RENDERED when the editor
 *                       opened, used as the RPC's `p_expected_items` concurrency
 *                       precondition. This is what makes the guard cover the full
 *                       view-to-write window instead of only the EF-read→lock gap.
 *
 * The two MUST NOT be confused: sourcing the baseline from the draft would make
 * the guard 409 every legitimate reduction (current-under-lock != target with no
 * concurrent edit). See quantity-edit-payload.test.ts.
 */
export interface QuantityEditItem {
  service_id: string
  no_services: number
}

export function buildQuantityEditItems(
  serviceLines: ReadonlyArray<{ service_id: string; qty: number }>,
  editQty: ReadonlyMap<string, number>,
): { items: QuantityEditItem[]; expectedItems: QuantityEditItem[] } {
  const items = serviceLines.map((l) => ({
    service_id: l.service_id,
    no_services: editQty.get(l.service_id) ?? l.qty,
  }))
  const expectedItems = serviceLines.map((l) => ({
    service_id: l.service_id,
    no_services: l.qty,
  }))
  return { items, expectedItems }
}
