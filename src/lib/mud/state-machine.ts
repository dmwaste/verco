/**
 * MUD onboarding state machine.
 *
 * Mirrors the brief's §6 state diagram and the DB CHECK constraints in
 * supabase/migrations/20260408100300_mud_add_constraints.sql.
 *
 * States:
 *   Contact Made — record exists, not bookable (initial state when is_mud=true)
 *   Registered   — bookable, all prereqs met
 *   Inactive     — record preserved but not bookable
 *
 * Transitions:
 *   Contact Made → Registered  (gated on prereqs — see canMarkRegistered)
 *   Registered    → Inactive   (always allowed)
 *   Inactive      → Registered (always allowed — no re-onboarding needed)
 *
 * Disallowed (intentional):
 *   Contact Made → Inactive    (delete the record instead)
 *   Registered    → Contact Made
 *   Inactive      → Contact Made
 *
 * The DB enforces the prereqs via the eligible_properties_registered_check
 * constraint. This module enables client-side checks for inline form validation
 * and testability without a DB roundtrip.
 */

export const MUD_ONBOARDING_STATUSES = [
  'Contact Made',
  'Registered',
  'Inactive',
] as const

export type MudOnboardingStatus = (typeof MUD_ONBOARDING_STATUSES)[number]

const VALID_TRANSITIONS: ReadonlyMap<MudOnboardingStatus, readonly MudOnboardingStatus[]> =
  new Map([
    ['Contact Made', ['Registered']],
    ['Registered', ['Inactive']],
    ['Inactive', ['Registered']],
  ])

/**
 * Pure transition check — does NOT validate Registered prereqs.
 * Use canMarkRegistered() for that.
 */
export function canTransition(from: MudOnboardingStatus, to: MudOnboardingStatus): boolean {
  if (from === to) return false
  const allowed = VALID_TRANSITIONS.get(from) ?? []
  return allowed.includes(to)
}

export function getValidTargets(from: MudOnboardingStatus): readonly MudOnboardingStatus[] {
  return VALID_TRANSITIONS.get(from) ?? []
}

/**
 * Prerequisites for marking a MUD as Registered. Mirrors the DB constraint
 * eligible_properties_registered_check + the brief's §6 transition gate.
 *
 * unit_count > 0 is required for Registered — the allowance calculation needs
 * a real count. There is no council-set minimum; 0 means "not yet recorded".
 */
export interface MudRegisteredPrereqs {
  is_mud: boolean
  unit_count: number
  strata_contact_id: string | null
  auth_form_url: string | null
  waste_location_notes: string | null
  collection_cadence: string | null
}

export interface PrereqCheckResult {
  ok: boolean
  errors: string[]
}

export function canMarkRegistered(record: MudRegisteredPrereqs): PrereqCheckResult {
  const errors: string[] = []

  if (!record.is_mud) {
    errors.push('Property is not flagged as a MUD.')
  }
  if (record.unit_count < 1) {
    errors.push('Unit count must be recorded before registering (currently 0).')
  }
  if (!record.strata_contact_id) {
    errors.push('Strata contact is required.')
  }
  if (!record.auth_form_url) {
    errors.push('Authorisation form must be uploaded.')
  }
  if (!record.waste_location_notes || record.waste_location_notes.trim() === '') {
    errors.push('Waste location notes are required.')
  }
  if (!record.collection_cadence) {
    errors.push('Collection cadence must be set.')
  }

  return { ok: errors.length === 0, errors }
}
