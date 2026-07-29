/**
 * Zod schemas for MUD onboarding form input.
 *
 * Two schemas:
 *   - mudPropertyDraftSchema: minimum to create a MUD record (Contact Made state)
 *   - mudPropertyRegisteredSchema: full prereqs to mark a MUD as Registered
 *
 * The DB enforces these via CHECK constraints; these schemas give callers
 * inline form validation and a single source of error messages.
 */

import { z } from 'zod'
import { MUD_ONBOARDING_STATUSES } from './state-machine'

export const COLLECTION_CADENCES = ['Ad-hoc', 'Annual', 'Bi-annual', 'Quarterly'] as const
export type CollectionCadence = (typeof COLLECTION_CADENCES)[number]

/**
 * Form floor for unit_count data entry. The server/draft semantics still allow 0
 * ("not yet recorded" — see canMarkRegistered), but both admin forms require a
 * real count when saving.
 */
export const MUD_MIN_UNIT_COUNT = 1

/**
 * Phone validation for strata contacts (VER-315).
 *
 * A strata manager's contact number is often NOT a mobile — business landlines
 * and 1300/1800 service lines are common. The helpers now live in the mirrored
 * single-brain module (src/lib/phone.ts ← _shared/phone.ts) shared with the
 * resident booking flow (#457); re-exported here for existing consumers.
 */
export { normalisePhone, isValidPhone, canonicaliseAuMobile, isSmsCapable } from '@/lib/phone'

// NOTE: the strata contact schema lives in the upsertStrataContact server action
// (app/(admin)/admin/properties/actions.ts) — the single validating write path.
// A duplicate schema here had zero consumers and silently drifted from the real
// one, so it was removed (VER-315 review).

/**
 * Minimum draft to create a MUD record (Contact Made state).
 * unit_count=0 is valid and means "not yet recorded" — no council-set minimum.
 * cadence must be set because the DB CHECK requires it for is_mud=true.
 */
export const mudPropertyDraftSchema = z.object({
  property_id: z.string().uuid().optional(),
  collection_area_id: z.string().uuid(),
  address: z.string().min(1, 'Address is required'),
  unit_count: z.number().int().min(0, 'Unit count cannot be negative'),
  mud_code: z
    .string()
    .min(1, 'MUD code is required')
    .max(40)
    .regex(/^[A-Z0-9-]+$/, 'MUD code must be uppercase letters, numbers, and hyphens'),
  collection_cadence: z.enum(COLLECTION_CADENCES),
  waste_location_notes: z.string().max(2000).optional().nullable(),
})

export type MudPropertyDraftInput = z.infer<typeof mudPropertyDraftSchema>

/**
 * Full set required to transition a MUD to Registered.
 * Mirrors canMarkRegistered() in state-machine.ts.
 */
export const mudPropertyRegisteredSchema = mudPropertyDraftSchema.extend({
  strata_contact_id: z.string().uuid({ message: 'Strata contact is required' }),
  auth_form_url: z.string().url({ message: 'Auth form must be uploaded' }),
  waste_location_notes: z.string().min(1, 'Waste location notes are required').max(2000),
})

export type MudPropertyRegisteredInput = z.infer<typeof mudPropertyRegisteredSchema>

export const mudOnboardingStatusSchema = z.enum(MUD_ONBOARDING_STATUSES)
