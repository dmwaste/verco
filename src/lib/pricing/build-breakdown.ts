/**
 * Build the confirm-page "Included / Extra Services" display breakdown from the
 * authoritative dual-limit pricing engine.
 *
 * Previously the confirm page reimplemented pricing with service-only logic,
 * which silently dropped paid units whose paid-ness came from the *category*
 * cap (not the per-service limit) — the breakdown disagreed with the total.
 * This helper drives the breakdown from `computeLineItems` (the same engine
 * services-form and the create-booking EF use) so the two can never diverge.
 */
import { computeLineItems, type ServiceRule } from './calculate'

export interface BreakdownInput {
  /** Selected service_id → quantity, in the same order the cart was built. */
  items: Array<{ service_id: string; quantity: number }>
  /** service_id → display name. */
  serviceNames: Map<string, string>
  /** service_id → category code (e.g. 'bulk', 'anc'). */
  serviceCategoryMap: Map<string, string>
  /** service_id → { max_collections, extra_unit_price }. */
  rulesMap: Map<string, ServiceRule>
  /** category code → category max_collections. */
  categoryMaxMap: Map<string, number>
  /** service_id → FY units already used this year. */
  serviceUsageMap: Map<string, number>
  /** category code → FY units already used this year. */
  categoryUsageMap: Map<string, number>
}

export interface IncludedLine {
  name: string
  qty: number
}

export interface ExtraLine {
  name: string
  qty: number
  /** Dollars, not cents. */
  unitPrice: number
  /** Dollars, not cents. */
  lineTotal: number
}

export interface ConfirmBreakdown {
  included: IncludedLine[]
  extras: ExtraLine[]
}

export function buildConfirmBreakdown(input: BreakdownInput): ConfirmBreakdown {
  const priced = computeLineItems(
    input.items,
    input.rulesMap,
    input.categoryMaxMap,
    input.serviceCategoryMap,
    input.serviceUsageMap,
    input.categoryUsageMap,
  )

  const included: IncludedLine[] = []
  const extras: ExtraLine[] = []

  for (const line of priced.line_items) {
    const name = input.serviceNames.get(line.service_id) ?? line.service_id
    if (line.free_units > 0) {
      included.push({ name, qty: line.free_units })
    }
    if (line.paid_units > 0) {
      extras.push({
        name,
        qty: line.paid_units,
        unitPrice: line.unit_price_cents / 100,
        lineTotal: line.line_charge_cents / 100,
      })
    }
  }

  return { included, extras }
}
