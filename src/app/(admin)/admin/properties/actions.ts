'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { canMarkRegistered } from '@/lib/mud/state-machine'
import { normaliseAuMobile } from '@/lib/booking/schemas'
import { normalisePhone } from '@/lib/mud/validation'
import type { Database } from '@/lib/supabase/types'
import type { Result } from '@/lib/result'
import { validateStaffRole } from '@/lib/auth/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'

type CollectionCadence = Database['public']['Enums']['collection_cadence']
type MudOnboardingStatus = Database['public']['Enums']['mud_onboarding_status']

// ----------------------------------------------------------------------------
// Strata contact upsert
// ----------------------------------------------------------------------------

export interface StrataContactInput {
  property_id: string
  first_name: string
  last_name: string
  mobile_e164: string
  email: string
}

const strataContactSchema = z.object({
  property_id: z.string().uuid(),
  first_name: z.string().trim().min(1, 'First name is required').max(100),
  last_name: z.string().trim().min(1, 'Last name is required').max(100),
  // Accept any real phone (mobile / landline / 1300 / 1800 / intl), then canonicalise
  // on store: mobiles → E.164 (+61…) so NCN SMS works (dispatch.ts sends mobile_e164
  // verbatim to Twilio); landlines/1300 → formatting-stripped (they never SMS). VER-315.
  mobile_e164: z
    .string()
    .trim()
    .min(6, 'Phone number is required')
    .max(20)
    .transform((v) => normaliseAuMobile(v) ?? normalisePhone(v)),
  email: z.string().trim().email('Invalid email').max(255),
})

/**
 * Looks up an existing contact by email; creates one if not found; links it
 * to the property — all atomically inside the upsert_strata_contact_and_link
 * SECURITY DEFINER RPC (VER-255). contacts has no write policies, and an
 * INSERT…RETURNING would be RLS-blocked until the link exists (chicken-and-
 * egg) — the RPC owns the whole sequence so no orphan/no-op states exist.
 * Tenant + sub-client scope are enforced in the RPC via the property's area.
 */
export async function upsertStrataContact(
  input: StrataContactInput
): Promise<Result<{ contact_id: string }>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const parsed = strataContactSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }

  const supabase = await createClient()

  const { data, error } = await supabase.rpc('upsert_strata_contact_and_link', {
    p_property_id: parsed.data.property_id,
    p_first_name: parsed.data.first_name,
    p_last_name: parsed.data.last_name,
    p_mobile_e164: parsed.data.mobile_e164,
    p_email: parsed.data.email,
  })

  if (error) return { ok: false, error: error.message }

  const contactId = (data as { contact_id?: string } | null)?.contact_id
  if (!contactId) {
    return { ok: false, error: 'Contact saved but no id was returned.' }
  }

  revalidatePath(`/admin/properties/${parsed.data.property_id}`)
  return { ok: true, data: { contact_id: contactId } }
}

// ----------------------------------------------------------------------------
// Add a single eligible property (manual one-off address)
// ----------------------------------------------------------------------------

export interface CreateEligiblePropertyInput {
  collection_area_id: string
  address: string
}

const createEligiblePropertySchema = z.object({
  collection_area_id: z.string().uuid('Select a collection area'),
  address: z.string().trim().min(5, 'Enter a full street address').max(255),
})

/**
 * Adds one eligible_properties row for a manually-supplied address — the
 * single-address sibling of the CSV import. Insert is RLS-gated by
 * eligible_properties_staff_insert (staff role + area in an accessible client +
 * sub-client scope), so no service role. Coords are left null / has_geocode
 * false; the caller triggers the geocode-properties EF afterwards (same as the
 * bulk import). Guards against creating a duplicate address in the same area —
 * duplicates break that address's /book lookup, which bails on >1 row
 * (see memory eligible-properties-duplicate-imports).
 */
export async function createEligibleProperty(
  input: CreateEligiblePropertyInput
): Promise<Result<{ property_id: string }>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const parsed = createEligiblePropertySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }
  const { collection_area_id, address } = parsed.data

  const supabase = await createClient()

  // Tenant-scope the area (VER-281 class): collection_area is public-SELECT, so
  // verify the area belongs to the acting admin's current client before we
  // attach a property to it. (The insert RLS policy also enforces this, but the
  // explicit check yields a clean error instead of an opaque RLS failure.)
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  const { data: area, error: areaError } = await supabase
    .from('collection_area')
    .select('id, code')
    .eq('id', collection_area_id)
    .eq('client_id', clientId)
    .single()

  if (areaError || !area) {
    return { ok: false, error: 'Collection area not found for the current client.' }
  }

  // Duplicate guard — case-insensitive exact match within the same area.
  // `.ilike` with no wildcard chars is an exact case-insensitive compare.
  const { data: existing, error: dupError } = await supabase
    .from('eligible_properties')
    .select('id')
    .eq('collection_area_id', collection_area_id)
    .ilike('address', address)
    .limit(1)

  if (dupError) return { ok: false, error: dupError.message }
  if (existing && existing.length > 0) {
    return {
      ok: false,
      error: `That address already exists in ${area.code}.`,
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('eligible_properties')
    .insert({ address, collection_area_id })
    .select('id')
    .single()

  if (insertError || !inserted) {
    return { ok: false, error: insertError?.message ?? 'Failed to add property.' }
  }

  revalidatePath('/admin/properties')
  return { ok: true, data: { property_id: inserted.id } }
}

// ----------------------------------------------------------------------------
// MUD code suggestion (next available <areacode>-MUD-NN for an area)
// ----------------------------------------------------------------------------

export async function suggestMudCode(
  collection_area_id: string
): Promise<Result<{ mud_code: string }>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  // Tenant-scope (VER-281 class): collection_area is public-SELECT, so without
  // the client filter a staff user could read a foreign area's code + MUD codes
  // by passing another tenant's area id.
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  const { data: area, error: areaError } = await supabase
    .from('collection_area')
    .select('code')
    .eq('id', collection_area_id)
    .eq('client_id', clientId)
    .single()

  if (areaError || !area) {
    return { ok: false, error: areaError?.message ?? 'Collection area not found' }
  }

  const { data: existing, error: existingError } = await supabase
    .from('eligible_properties')
    .select('mud_code')
    .eq('collection_area_id', collection_area_id)
    .not('mud_code', 'is', null)

  if (existingError) return { ok: false, error: existingError.message }

  const prefix = `${area.code}-MUD-`
  const used = new Set<number>()
  for (const row of existing ?? []) {
    if (!row.mud_code) continue
    if (!row.mud_code.startsWith(prefix)) continue
    const tail = row.mud_code.slice(prefix.length)
    const n = Number.parseInt(tail, 10)
    if (Number.isFinite(n)) used.add(n)
  }

  let next = 1
  while (used.has(next)) next++

  const padded = next.toString().padStart(2, '0')
  return { ok: true, data: { mud_code: `${prefix}${padded}` } }
}

// ----------------------------------------------------------------------------
// Property updates — set/unset MUD, transition state
// ----------------------------------------------------------------------------

export interface CreateMudPropertyInput {
  property_id: string  // existing eligible_properties row to convert
  unit_count: number
  mud_code: string
  collection_cadence: CollectionCadence
  waste_location_notes?: string | null
  strata_contact_id?: string | null
  auth_form_url?: string | null
}

/**
 * Converts an existing eligible_properties row into a MUD record at
 * 'Contact Made' state. Optional Registered prereqs can also be passed and
 * stored — but the status stays 'Contact Made' until markMudRegistered() is
 * called explicitly.
 */
export async function createMudProperty(
  input: CreateMudPropertyInput
): Promise<Result<{ property_id: string }>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  const { error } = await supabase
    .from('eligible_properties')
    .update({
      is_mud: true,
      unit_count: input.unit_count,
      mud_code: input.mud_code,
      mud_onboarding_status: 'Contact Made' as MudOnboardingStatus,
      collection_cadence: input.collection_cadence,
      waste_location_notes: input.waste_location_notes ?? null,
      strata_contact_id: input.strata_contact_id ?? null,
      auth_form_url: input.auth_form_url ?? null,
    })
    .eq('id', input.property_id)

  if (error) return { ok: false, error: error.message }

  revalidatePath('/admin/properties')
  revalidatePath(`/admin/properties/${input.property_id}`)
  return { ok: true, data: { property_id: input.property_id } }
}

export interface UpdateMudPropertyInput {
  property_id: string
  unit_count?: number
  mud_code?: string
  collection_cadence?: CollectionCadence
  waste_location_notes?: string | null
  strata_contact_id?: string | null
  auth_form_url?: string | null
}

export async function updateMudProperty(
  input: UpdateMudPropertyInput
): Promise<Result<{ property_id: string }>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  const patch: Record<string, unknown> = {}
  if (input.unit_count !== undefined) patch.unit_count = input.unit_count
  if (input.mud_code !== undefined) patch.mud_code = input.mud_code
  if (input.collection_cadence !== undefined) patch.collection_cadence = input.collection_cadence
  if (input.waste_location_notes !== undefined) patch.waste_location_notes = input.waste_location_notes
  if (input.strata_contact_id !== undefined) patch.strata_contact_id = input.strata_contact_id
  if (input.auth_form_url !== undefined) patch.auth_form_url = input.auth_form_url

  const { error } = await supabase
    .from('eligible_properties')
    .update(patch)
    .eq('id', input.property_id)

  if (error) return { ok: false, error: error.message }

  revalidatePath('/admin/properties')
  revalidatePath(`/admin/properties/${input.property_id}`)
  return { ok: true, data: { property_id: input.property_id } }
}

export async function markMudRegistered(
  property_id: string
): Promise<Result<{ property_id: string }>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  // Tenant-scope the pre-read (VER-281 class): eligible_properties is
  // public-SELECT, so scope by the property's area client.
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  // Re-fetch the row to validate prereqs server-side
  const { data: row, error: fetchError } = await supabase
    .from('eligible_properties')
    .select(
      'is_mud, unit_count, strata_contact_id, auth_form_url, waste_location_notes, collection_cadence, mud_onboarding_status, collection_area!inner(client_id)'
    )
    .eq('id', property_id)
    .eq('collection_area.client_id', clientId)
    .single()

  if (fetchError || !row) {
    return { ok: false, error: fetchError?.message ?? 'Property not found' }
  }

  if (row.mud_onboarding_status !== 'Contact Made' && row.mud_onboarding_status !== 'Inactive') {
    return {
      ok: false,
      error: `Cannot mark Registered from current status (${row.mud_onboarding_status ?? 'null'}).`,
    }
  }

  const prereq = canMarkRegistered({
    is_mud: row.is_mud,
    unit_count: row.unit_count,
    strata_contact_id: row.strata_contact_id,
    auth_form_url: row.auth_form_url,
    waste_location_notes: row.waste_location_notes,
    collection_cadence: row.collection_cadence,
  })

  if (!prereq.ok) {
    return { ok: false, error: prereq.errors.join(' ') }
  }

  const { error: updateError } = await supabase
    .from('eligible_properties')
    .update({ mud_onboarding_status: 'Registered' as MudOnboardingStatus })
    .eq('id', property_id)

  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath('/admin/properties')
  revalidatePath(`/admin/properties/${property_id}`)
  return { ok: true, data: { property_id } }
}

export async function markMudInactive(
  property_id: string
): Promise<Result<{ property_id: string }>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  // Tenant-scope the pre-read (VER-281 class) by the property's area client.
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  const { data: row, error: fetchError } = await supabase
    .from('eligible_properties')
    .select('mud_onboarding_status, collection_area!inner(client_id)')
    .eq('id', property_id)
    .eq('collection_area.client_id', clientId)
    .single()

  if (fetchError || !row) {
    return { ok: false, error: fetchError?.message ?? 'Property not found' }
  }

  if (row.mud_onboarding_status !== 'Registered') {
    return {
      ok: false,
      error: 'Only Registered MUDs can be marked Inactive. Delete Contact Made MUDs instead.',
    }
  }

  const { error: updateError } = await supabase
    .from('eligible_properties')
    .update({ mud_onboarding_status: 'Inactive' as MudOnboardingStatus })
    .eq('id', property_id)

  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath('/admin/properties')
  revalidatePath(`/admin/properties/${property_id}`)
  return { ok: true, data: { property_id } }
}

export async function reactivateMud(
  property_id: string
): Promise<Result<{ property_id: string }>> {
  // Inactive → Registered. The DB constraint already requires the prereqs
  // to still be present, so no extra check needed beyond the state guard.
  return markMudRegistered(property_id)
}

// ----------------------------------------------------------------------------
// Auth form upload — generates a signed upload URL for the client
// ----------------------------------------------------------------------------

export interface SignedUploadUrl {
  upload_url: string
  token: string
  path: string
}

export async function createAuthFormUploadUrl(
  property_id: string,
  collection_area_id: string,
  filename: string
): Promise<Result<SignedUploadUrl>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  // Sanitise filename
  const safeName = filename.replace(/[^\w.-]+/g, '_').slice(0, 120)
  const uniq = crypto.randomUUID()
  const path = `${collection_area_id}/${property_id}/${uniq}-${safeName}`

  const { data, error } = await supabase.storage
    .from('mud-auth-forms')
    .createSignedUploadUrl(path)

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create upload URL' }
  }

  return {
    ok: true,
    data: {
      upload_url: data.signedUrl,
      token: data.token,
      path: data.path,
    },
  }
}

export async function getAuthFormSignedUrl(
  path: string
): Promise<Result<{ url: string }>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  const { data, error } = await supabase.storage
    .from('mud-auth-forms')
    .createSignedUrl(path, 60 * 60) // 1 hour

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create signed URL' }
  }

  return { ok: true, data: { url: data.signedUrl } }
}
