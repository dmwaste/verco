'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import type { Result } from '@/lib/result'

// ── Schemas ────────────────────────────────────────────────────

const slugSchema = z.string().min(1).max(50).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens')

const createClientSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: slugSchema,
  primary_colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  accent_colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
})

const updateClientSchema = z.object({
  name: z.string().min(1).optional(),
  slug: slugSchema.optional(),
  is_active: z.boolean().optional(),
  service_name: z.string().nullable().optional(),
  custom_domain: z.string().nullable().optional(),
  contact_name: z.string().nullable().optional(),
  contact_phone: z.string().nullable().optional(),
  contact_email: z.string().email().nullable().optional(),
  privacy_policy_url: z.string().url().nullable().optional(),
  landing_headline: z.string().nullable().optional(),
  landing_subheading: z.string().nullable().optional(),
  primary_colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  accent_colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  logo_light_url: z.string().nullable().optional(),
  logo_dark_url: z.string().nullable().optional(),
  hero_banner_url: z.string().nullable().optional(),
  show_powered_by: z.boolean().optional(),
  email_from_name: z.string().nullable().optional(),
  reply_to_email: z.string().email().nullable().optional(),
  sms_sender_id: z.string().max(11).regex(/^[a-zA-Z0-9]*$/).nullable().optional(),
  sms_reminder_days_before: z.number().int().min(1).max(7).nullable().optional(),
  email_footer_html: z.string().nullable().optional(),
})

const faqItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
})

const createSubClientSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  code: z.string().min(1, 'Code is required').max(20),
})

const updateSubClientSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().min(1).max(20).optional(),
  is_active: z.boolean().optional(),
})

const createAreaSchema = z.object({
  code: z.string().min(1, 'Code is required').max(20),
  name: z.string().min(1, 'Name is required'),
  sub_client_id: z.string().uuid().nullable().optional(),
  dm_job_code: z.string().nullable().optional(),
})

const updateAreaSchema = z.object({
  code: z.string().min(1).max(20).optional(),
  name: z.string().min(1).optional(),
  sub_client_id: z.string().uuid().nullable().optional(),
  dm_job_code: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
})

const allocationRuleSchema = z.object({
  category_id: z.string().uuid(),
  max_collections: z.number().int().min(0),
})

const serviceRuleSchema = z.object({
  service_id: z.string().uuid(),
  max_collections: z.number().int().min(0),
  extra_unit_price: z.number().min(0),
})

// ── Helpers ────────────────────────────────────────────────────

async function getContractorId(): Promise<string> {
  const headerStore = await headers()
  const contractorId = headerStore.get('x-contractor-id')
  if (!contractorId) throw new Error('Missing x-contractor-id header')
  return contractorId
}

// ── Client Actions ─────────────────────────────────────────────

export async function createNewClient(
  input: z.infer<typeof createClientSchema>,
): Promise<Result<{ id: string }>> {
  const parsed = createClientSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const supabase = await createClient()
  const contractorId = await getContractorId()

  const { data, error } = await supabase
    .from('client')
    .insert({
      ...parsed.data,
      contractor_id: contractorId,
      primary_colour: parsed.data.primary_colour ?? '#293F52',
      accent_colour: parsed.data.accent_colour ?? '#00E47C',
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { id: data.id } }
}

export async function updateClient(
  clientId: string,
  input: z.infer<typeof updateClientSchema>,
): Promise<Result<void>> {
  const parsed = updateClientSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const supabase = await createClient()

  // .select().single() so an RLS deny surfaces as PGRST116 instead of a
  // silent {error:null,data:null}. Without this, write failures look like
  // success to the UI — branding form was reverting on refresh because
  // updates silently no-opped. CLAUDE.md §21 RLS write silent-fail.
  const { data, error } = await supabase
    .from('client')
    .update(parsed.data)
    .eq('id', clientId)
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Update was not applied (no matching row or insufficient permissions)' }
  return { ok: true, data: undefined }
}

export async function updateClientFaqs(
  clientId: string,
  items: Array<{ question: string; answer: string }>,
): Promise<Result<void>> {
  const parsed = z.array(faqItemSchema).safeParse(items)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('client')
    .update({ faq_items: parsed.data })
    .eq('id', clientId)
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Update was not applied (no matching row or insufficient permissions)' }
  return { ok: true, data: undefined }
}

// ── Sub-Client Actions ─────────────────────────────────────────

export async function createSubClient(
  clientId: string,
  input: z.infer<typeof createSubClientSchema>,
): Promise<Result<{ id: string }>> {
  const parsed = createSubClientSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('sub_client')
    .insert({ ...parsed.data, client_id: clientId })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') return { ok: false, error: `Code "${parsed.data.code}" already exists for this client.` }
    return { ok: false, error: error.message }
  }
  return { ok: true, data: { id: data.id } }
}

export async function updateSubClient(
  subClientId: string,
  input: z.infer<typeof updateSubClientSchema>,
): Promise<Result<void>> {
  const parsed = updateSubClientSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('sub_client')
    .update(parsed.data)
    .eq('id', subClientId)
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') return { ok: false, error: `Code "${parsed.data.code}" already exists for this client.` }
    return { ok: false, error: error.message }
  }
  if (!data) return { ok: false, error: 'Update was not applied (no matching row or insufficient permissions)' }
  return { ok: true, data: undefined }
}

// ── Collection Area Actions ────────────────────────────────────

export async function createCollectionArea(
  clientId: string,
  input: z.infer<typeof createAreaSchema>,
): Promise<Result<{ id: string }>> {
  const parsed = createAreaSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const supabase = await createClient()
  const contractorId = await getContractorId()

  const { data, error } = await supabase
    .from('collection_area')
    .insert({
      ...parsed.data,
      client_id: clientId,
      contractor_id: contractorId,
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') return { ok: false, error: `Code "${parsed.data.code}" already exists for this client.` }
    return { ok: false, error: error.message }
  }
  return { ok: true, data: { id: data.id } }
}

export async function updateCollectionArea(
  areaId: string,
  input: z.infer<typeof updateAreaSchema>,
): Promise<Result<void>> {
  const parsed = updateAreaSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('collection_area')
    .update(parsed.data)
    .eq('id', areaId)
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Update was not applied (no matching row or insufficient permissions)' }
  return { ok: true, data: undefined }
}

// ── Allocation & Service Rules ─────────────────────────────────

export async function upsertAllocationRules(
  areaId: string,
  rules: Array<z.infer<typeof allocationRuleSchema>>,
): Promise<Result<void>> {
  const parsed = z.array(allocationRuleSchema).safeParse(rules)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const supabase = await createClient()

  // Delete existing rules for this area, then insert new ones
  const { error: deleteError } = await supabase
    .from('allocation_rules')
    .delete()
    .eq('collection_area_id', areaId)

  if (deleteError) return { ok: false, error: deleteError.message }

  if (parsed.data.length > 0) {
    const rows = parsed.data.map((r) => ({
      collection_area_id: areaId,
      category_id: r.category_id,
      max_collections: r.max_collections,
    }))

    const { error: insertError } = await supabase
      .from('allocation_rules')
      .insert(rows)

    if (insertError) return { ok: false, error: insertError.message }
  }

  return { ok: true, data: undefined }
}

export async function upsertServiceRules(
  areaId: string,
  rules: Array<z.infer<typeof serviceRuleSchema>>,
): Promise<Result<void>> {
  const parsed = z.array(serviceRuleSchema).safeParse(rules)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const supabase = await createClient()

  const { error: deleteError } = await supabase
    .from('service_rules')
    .delete()
    .eq('collection_area_id', areaId)

  if (deleteError) return { ok: false, error: deleteError.message }

  if (parsed.data.length > 0) {
    const rows = parsed.data.map((r) => ({
      collection_area_id: areaId,
      service_id: r.service_id,
      max_collections: r.max_collections,
      extra_unit_price: r.extra_unit_price,
    }))

    const { error: insertError } = await supabase
      .from('service_rules')
      .insert(rows)

    if (insertError) return { ok: false, error: insertError.message }
  }

  return { ok: true, data: undefined }
}
