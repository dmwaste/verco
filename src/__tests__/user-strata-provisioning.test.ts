/**
 * Contract tests for strata user provisioning validation.
 * These mirror the superRefine rules in user-form-dialog.tsx and the
 * Zod refinements in supabase/functions/create-user/index.ts.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// ── Inline schema matching user-form-dialog.tsx strata validation ────────────

const STRATA_FORM_RULES = z
  .object({
    role: z.string(),
    tenant_id: z.string().uuid().or(z.literal('')).optional(),
    mud_property_ids: z.string().uuid().array().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === 'strata') {
      if (!data.tenant_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Please select a client.',
          path: ['tenant_id'],
        })
      }
      if (!data.mud_property_ids || data.mud_property_ids.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Select at least one MUD property.',
          path: ['mud_property_ids'],
        })
      }
    }
  })

const A_CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROP_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PROP_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

// ── Form-side validation ─────────────────────────────────────────────────────

describe('strata form — client and property requirements', () => {
  it('fails when no tenant_id is provided', () => {
    const result = STRATA_FORM_RULES.safeParse({
      role: 'strata',
      mud_property_ids: [PROP_A],
    })
    expect(result.success).toBe(false)
    const paths = result.error?.issues.map((e: z.ZodIssue) => e.path[0])
    expect(paths).toContain('tenant_id')
  })

  it('fails when mud_property_ids is empty', () => {
    const result = STRATA_FORM_RULES.safeParse({
      role: 'strata',
      tenant_id: A_CLIENT_ID,
      mud_property_ids: [],
    })
    expect(result.success).toBe(false)
    const paths = result.error?.issues.map((e: z.ZodIssue) => e.path[0])
    expect(paths).toContain('mud_property_ids')
  })

  it('fails when mud_property_ids is absent', () => {
    const result = STRATA_FORM_RULES.safeParse({
      role: 'strata',
      tenant_id: A_CLIENT_ID,
    })
    expect(result.success).toBe(false)
    const paths = result.error?.issues.map((e: z.ZodIssue) => e.path[0])
    expect(paths).toContain('mud_property_ids')
  })

  it('passes with one property', () => {
    const result = STRATA_FORM_RULES.safeParse({
      role: 'strata',
      tenant_id: A_CLIENT_ID,
      mud_property_ids: [PROP_A],
    })
    expect(result.success).toBe(true)
  })

  it('passes with multiple properties', () => {
    const result = STRATA_FORM_RULES.safeParse({
      role: 'strata',
      tenant_id: A_CLIENT_ID,
      mud_property_ids: [PROP_A, PROP_B],
    })
    expect(result.success).toBe(true)
  })

  it('does not require mud_property_ids for non-strata roles', () => {
    const result = STRATA_FORM_RULES.safeParse({
      role: 'client-admin',
      tenant_id: A_CLIENT_ID,
      mud_property_ids: [],
    })
    expect(result.success).toBe(true)
  })
})

// ── EF-side validation (same contract) ──────────────────────────────────────

const STRATA_EF_RULES = z
  .object({
    role: z.string(),
    client_id: z.string().uuid().optional(),
    mud_property_ids: z.string().uuid().array().optional(),
  })
  .refine(
    (data) => data.role !== 'strata' || !!data.client_id,
    { message: 'Strata users require client_id.' }
  )
  .refine(
    (data) => data.role !== 'strata' || (!!data.mud_property_ids && data.mud_property_ids.length > 0),
    { message: 'Strata users require at least one MUD property.', path: ['mud_property_ids'] }
  )

describe('strata EF — client_id and mud_property_ids requirements', () => {
  it('rejects strata with no client_id', () => {
    const result = STRATA_EF_RULES.safeParse({ role: 'strata', mud_property_ids: [PROP_A] })
    expect(result.success).toBe(false)
  })

  it('rejects strata with empty mud_property_ids', () => {
    const result = STRATA_EF_RULES.safeParse({
      role: 'strata',
      client_id: A_CLIENT_ID,
      mud_property_ids: [],
    })
    expect(result.success).toBe(false)
    const paths = result.error?.issues.map((e: z.ZodIssue) => e.path[0])
    expect(paths).toContain('mud_property_ids')
  })

  it('accepts strata with valid client_id and ≥1 property', () => {
    const result = STRATA_EF_RULES.safeParse({
      role: 'strata',
      client_id: A_CLIENT_ID,
      mud_property_ids: [PROP_A, PROP_B],
    })
    expect(result.success).toBe(true)
  })

  it('does not require mud_property_ids for resident role', () => {
    const result = STRATA_EF_RULES.safeParse({ role: 'resident' })
    expect(result.success).toBe(true)
  })
})
