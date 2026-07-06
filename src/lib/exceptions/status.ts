import type { Database } from '@/lib/supabase/types'

/**
 * Shared NCN/NP exception status groupings.
 *
 * An "exception" is a notice record (`non_conformance_notice` / `nothing_presented`),
 * raised per stop = booking × waste stream. Its lifecycle is the investigation.
 * See docs/superpowers/specs/2026-07-06-ncn-np-investigations-model-design.md.
 *
 * Both `ncn_status` and `np_status` share these values, so one set serves both.
 */
export type NcnStatus = Database['public']['Enums']['ncn_status']
export type NpStatus = Database['public']['Enums']['np_status']

/**
 * An investigation is "open" — needs staff attention — when it is being disputed
 * or actively reviewed. Drives the sidebar badges and the dashboard
 * "Open Investigations" surfaces. Excludes `Issued` (raised, not yet actioned)
 * and every terminal state.
 */
export const OPEN_INVESTIGATION_STATUSES = ['Disputed', 'Under Review'] as const

/**
 * The exception tables default to the unresolved set: everything not yet terminal.
 * Superset of {@link OPEN_INVESTIGATION_STATUSES} plus freshly-raised `Issued`.
 * Terminal states (Resolved / Rescheduled / Rebooked / Closed) show only when the
 * user explicitly filters to them (or "All").
 */
export const OPEN_EXCEPTION_FILTER_STATUSES = ['Issued', 'Disputed', 'Under Review'] as const
