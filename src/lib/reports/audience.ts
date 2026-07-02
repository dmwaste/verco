/**
 * Per-metric audience gating for /admin/reports (VER-288, decision 8A).
 *
 * The reports page serves two audiences from one surface: D&M staff
 * (contractor-*) and council staff (client-admin / client-staff). Every card
 * declares its audience here; anything NOT listed is contractor-only — new
 * metrics are internal until Dan explicitly makes them council-visible.
 *
 * Council-visible set v1 (Dan, 02/07/2026): the contract/service KPIs and the
 * council's own operational counts. Contractor-only: D&M ops-health metrics
 * (notification delivery, self-service rate, property penetration) and
 * anything monetary (refunds — councils never see revenue/cost).
 *
 * Gating must be STRUCTURAL: a contractor-only card's component is not
 * mounted and its query never fires for council viewers — never CSS-hidden.
 */

export type MetricAudience = 'council-visible' | 'contractor-only'

/** Roles that see every card, regardless of audience. */
export const CONTRACTOR_REPORT_ROLES = ['contractor-admin', 'contractor-staff'] as const

export const METRIC_AUDIENCE = {
  // SLA dashboard (VER-179) — contract/service KPIs
  'service-delivery': 'council-visible',
  'on-time-collection': 'council-visible',
  'rectification': 'council-visible',
  'ticket-first-response': 'council-visible',
  'ticket-resolution': 'council-visible',
  'resident-satisfaction': 'council-visible',
  'service-breakdown': 'council-visible',
  // SLA dashboard — D&M ops-health (decision 8A: contractor-only)
  'property-penetration': 'contractor-only',
  'self-service-rate': 'contractor-only',
  'notification-delivery': 'contractor-only',
  // M2 delta cards (VER-294)
  'collections-trend': 'council-visible',
  'open-notices': 'council-visible',
  // Summary cards ('ncn-count'/'np-count' were retired for the three-way
  // 'open-notices' split card, VER-294)
  'total-bookings': 'council-visible',
  'bookings-by-status': 'council-visible',
  'open-tickets': 'council-visible',
  // Monetary — councils never see revenue/cost (booking_payment rule)
  'refunds': 'contractor-only',
} as const satisfies Record<string, MetricAudience>

export type MetricKey = keyof typeof METRIC_AUDIENCE

export function isContractorReportViewer(role: string | null | undefined): boolean {
  return (CONTRACTOR_REPORT_ROLES as readonly string[]).includes(role ?? '')
}

/**
 * Should this viewer see this metric? Contractor roles see everything;
 * everyone else sees only explicitly council-visible metrics. Unknown metric
 * keys are contractor-only by construction (safe default for new cards).
 */
export function metricVisible(metric: string, role: string | null | undefined): boolean {
  if (isContractorReportViewer(role)) return true
  const audience: MetricAudience =
    (METRIC_AUDIENCE as Record<string, MetricAudience>)[metric] ?? 'contractor-only'
  return audience === 'council-visible'
}
