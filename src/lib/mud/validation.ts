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
import { normaliseAuMobile } from '@/lib/booking/schemas'

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
 * and 1300/1800 service lines are common. The form must accept any real phone
 * format and reject only non-numeric junk; the server (actions.ts) stays the
 * authoritative min(6)/max(20) bound. SMS delivery is the notification layer's
 * concern (isSmsCapable), not a reason to reject a number.
 */
export const normalisePhone = (s: string) => s.replace(/[\s()\-.]/g, '')

/** Accepts mobile / landline / 1300 / 1800 / 13xx / international. Rejects letters, too-short, +0. */
export function isValidPhone(s: string): boolean {
  const v = normalisePhone(s.trim())
  return /^\+?\d{6,15}$/.test(v) && !v.startsWith('+0')
}

/**
 * Canonicalise an AU mobile written in any common form to E.164 (+614…), or null
 * when the input is not an AU mobile. Extends normaliseAuMobile (booking/schemas)
 * with the written variants it doesn't cover: dot separators, the 00 international
 * prefix, and the redundant national zero after the country code ("+61 0412 …").
 * MUST stay the single mobile-detection used by BOTH the UI hint (isSmsCapable)
 * and the store transform (actions.ts) — two brains here is how VER-315 happened.
 */
export function canonicaliseAuMobile(s: string): string | null {
  const v = normalisePhone(s.trim())
    .replace(/^00/, '+') // 0061… → +61…
    .replace(/^(\+?61)0(?=4)/, '$1') // +61 0412… → +61412…
  return normaliseAuMobile(v)
}

/** SMS-capable = AU mobile only. Drives the "won't receive SMS" hint. */
export const isSmsCapable = (s: string): boolean => canonicaliseAuMobile(s) !== null

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
