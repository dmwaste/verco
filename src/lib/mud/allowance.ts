/**
 * MUD allowance computation — pure logic, no DB calls.
 *
 * Caller fetches the inputs (service rules, current usage, overrides) and
 * passes them in. This module decides whether a proposed booking would exceed
 * the per-service hard cap.
 *
 * Mirrors the brief §6 Flow 2 step 3 and the dual-limit pricing engine pattern
 * in src/lib/pricing/calculate.ts. Unlike SUDs, MUDs do NOT support extras —
 * any over-cap booking is rejected outright (the resolution path is a manual
 * allocation_override grant via Flow 6).
 *
 * Allowance formula per service per FY:
 *   base    = unit_count × service_rules.max_collections
 *   bumps   = sum(allocation_override.extra_allocations for this service & FY)
 *   cap     = base + bumps
 *
 *   used    = sum of no_services across all booking_items for this property,
 *             this service, this FY, in non-Cancelled bookings
 *   request = no_services in the new booking
 *
 *   ok = (used + request) <= cap
 */

export interface MudAllowanceServiceInput {
  service_id: string
  service_name: string
  /** service_rules.max_collections for this property's collection area */
  max_collections_per_unit: number
  /** Sum of no_services already used in non-Cancelled bookings for this FY */
  used: number
  /** Sum of allocation_override.extra_allocations for this service + FY */
  override_extras: number
  /** no_services requested in the new booking */
  requested: number
}

export interface MudAllowanceCheckInput {
  unit_count: number
  services: MudAllowanceServiceInput[]
}

export interface MudAllowanceServiceResult {
  service_id: string
  service_name: string
  base_cap: number
  override_extras: number
  total_cap: number
  used: number
  requested: number
  remaining_after: number
  ok: boolean
}

export interface MudAllowanceCheckResult {
  ok: boolean
  per_service: MudAllowanceServiceResult[]
  errors: string[]
}

export function checkMudAllowance(input: MudAllowanceCheckInput): MudAllowanceCheckResult {
  const per_service: MudAllowanceServiceResult[] = []
  const errors: string[] = []

  if (input.unit_count < 1) {
    errors.push('Unit count must be recorded before bookings can be made (currently 0).')
  }

  for (const svc of input.services) {
    const base_cap = input.unit_count * svc.max_collections_per_unit
    const total_cap = base_cap + svc.override_extras
    const after = svc.used + svc.requested
    const remaining_after = total_cap - after
    const ok = after <= total_cap

    per_service.push({
      service_id: svc.service_id,
      service_name: svc.service_name,
      base_cap,
      override_extras: svc.override_extras,
      total_cap,
      used: svc.used,
      requested: svc.requested,
      remaining_after,
      ok,
    })

    if (!ok) {
      errors.push(
        `${svc.service_name} would exceed its allowance (${after}/${total_cap}). ` +
          `Contact D&M admin for an allowance grant.`
      )
    }
  }

  return {
    ok: errors.length === 0,
    per_service,
    errors,
  }
}
