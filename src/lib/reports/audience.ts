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
 * (notification delivery, self-service rate, property penetration). Anything
 * monetary stays OFF this page entirely (refund cards removed 02/07 —
 * councils never see revenue/cost, and D&M has the Refunds admin page).
 *
 * Gating must be STRUCTURAL: a contractor-only card's component is not
 * mounted and its query never fires for council viewers — never CSS-hidden.
 *
 * EXCEPTION — the shared monthly-series fetch (get_reports_monthly): council-
 * visible cards subscribe to it, so "the query never fires" cannot hold there.
 * Its contractor-only series (the self-service and notification ones) are
 * instead ROLE-FILTERED INSIDE the RPC (migration 20260702180000) — a new
 * series added to that RPC for a contractor-only metric MUST carry its own
 * v_contractor filter; this map does not gate it.
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
  // Customer Satisfaction section (booking/service/overall rating trio —
  // replaced the single 'resident-satisfaction' card, design 02/07)
  'customer-satisfaction': 'council-visible',
  'service-breakdown': 'council-visible',
  // SLA dashboard — D&M ops-health (decision 8A: contractor-only)
  'property-penetration': 'contractor-only',
  'self-service-rate': 'contractor-only',
  'notification-delivery': 'contractor-only',
  // M2 delta cards (VER-294; 'collections-trend' renders as the Total
  // Collections top-line card since batch 5)
  'collections-trend': 'council-visible',
  'open-notices': 'council-visible',
  'notice-types': 'council-visible',
  // Summary cards ('ncn-count'/'np-count' → the 'open-notices' split card,
  // VER-294; 'total-bookings'/'bookings-by-status' retired in batches 3–5)
  'open-tickets': 'council-visible',
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
