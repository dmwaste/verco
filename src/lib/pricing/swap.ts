/**
 * Allocation-swap helpers (Kwinana: 3 Ancillary -> 1 free Green).
 *
 * Pure logic shared by the services step, the confirm page, and the
 * create-booking EF re-validation. The conversion-rule query that produces a
 * `ConversionRuleRow` is centralised here (one place to get the multi-FK
 * embedded select right — see the gotcha note below).
 */
import type { ActiveConversion } from './calculate'

export interface SwapEligibilityInput {
  /** A conversion rule exists for this collection area. */
  hasRule: boolean
  /** Units of Ancillary already used by this property this FY. */
  ancillaryFyUsed: number
  /** This property already has a swap applied this FY. */
  hasExistingSwap: boolean
  /** Ancillary units currently in the cart. */
  ancillaryInCart: number
}

/**
 * The swap is all-or-nothing: offered ONLY when the property still has its full
 * Ancillary allocation (none used this FY, none in the current cart) and hasn't
 * already swapped.
 */
export function isSwapEligible(i: SwapEligibilityInput): boolean {
  return i.hasRule && i.ancillaryFyUsed === 0 && !i.hasExistingSwap && i.ancillaryInCart === 0
}

/**
 * Row shape returned by the `allocation_conversion_rule` query, flattened with
 * the from/to category codes resolved.
 */
export interface ConversionRuleRow {
  id: string
  from_units: number
  to_units: number
  to_service_id: string
  from_category_code: string
  to_category_code: string
}

export function toActiveConversion(rule: ConversionRuleRow): ActiveConversion {
  return {
    from_category_code: rule.from_category_code,
    to_category_code: rule.to_category_code,
    to_service_id: rule.to_service_id,
    from_units: rule.from_units,
    to_units: rule.to_units,
  }
}

/**
 * PostgREST select string for the active conversion rule of a collection area.
 *
 * Gotcha: two FKs (`from_allocation_rules_id`, `to_allocation_rules_id`) point
 * at the SAME `allocation_rules` table, so the embeds MUST be disambiguated with
 * the explicit FK-alias form (`alias:fk_column(...)`). A bare
 * `allocation_rules(...)` embed returns empty for authed users once a table
 * accumulates multiple FKs (see CLAUDE.md §21 / composite-fk-breaks-embed).
 *
 * Filter the result in the caller by
 * `from_allocation_rules.collection_area_id === collectionAreaId`.
 */
export const CONVERSION_RULE_SELECT =
  'id, from_units, to_units, to_service_id, ' +
  // `!inner` on from_allocation_rules so callers can filter by
  // `from_allocation_rules.collection_area_id` (an embedded-column filter only
  // narrows top-level rows on an inner join).
  'from_allocation_rules:from_allocation_rules_id!inner ( collection_area_id, category:category_id ( code ) ), ' +
  'to_allocation_rules:to_allocation_rules_id ( category:category_id ( code ) )'

/** Raw embedded row from CONVERSION_RULE_SELECT, before flattening. */
export interface RawConversionRuleRow {
  id: string
  from_units: number
  to_units: number
  to_service_id: string
  from_allocation_rules: { collection_area_id: string; category: { code: string } } | null
  to_allocation_rules: { category: { code: string } } | null
}

/**
 * Flatten a raw embedded row to `ConversionRuleRow`, or null if either embed is
 * missing (defensive — see the gotcha above).
 */
export function flattenConversionRule(raw: RawConversionRuleRow): ConversionRuleRow | null {
  if (!raw.from_allocation_rules?.category || !raw.to_allocation_rules?.category) return null
  return {
    id: raw.id,
    from_units: raw.from_units,
    to_units: raw.to_units,
    to_service_id: raw.to_service_id,
    from_category_code: raw.from_allocation_rules.category.code,
    to_category_code: raw.to_allocation_rules.category.code,
  }
}
