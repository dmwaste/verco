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

const auMobileRegex = /^(\+614\d{8}|04\d{8})$/

/**
 * Strata contact — name + mobile + email all required for MUDs.
 * The contacts table allows nulls on mobile, but the brief tightens this for
 * MUD strata managers (need both for NCN dual-recipient routing).
 */
export const strataContactSchema = z.object({
  first_name: z.string().min(1, 'First name is required').max(60),
  last_name: z.string().min(1, 'Last name is required').max(60),
  mobile_e164: z
    .string()
    .min(1, 'Mobile is required')
    .regex(auMobileRegex, 'Mobile must be an Australian number (04XX or +614XX)'),
  email: z.string().email('Email must be valid'),
})

export type StrataContactInput = z.infer<typeof strataContactSchema>

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
