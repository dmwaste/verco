'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { canMarkRegistered } from '@/lib/mud/state-machine'
import type { Database } from '@/lib/supabase/types'

type CollectionCadence = Database['public']['Enums']['collection_cadence']
type MudOnboardingStatus = Database['public']['Enums']['mud_onboarding_status']

type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E }

const STAFF_ROLES = ['contractor-admin', 'contractor-staff', 'client-admin', 'client-staff']

async function validateStaffRole(): Promise<Result<string>> {
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  if (!role || !STAFF_ROLES.includes(role)) {
    return { ok: false, error: 'Insufficient permissions. Admin role required.' }
  }
  return { ok: true, data: role }
}

// ----------------------------------------------------------------------------
// Strata contact upsert
// ----------------------------------------------------------------------------

export interface StrataContactInput {
  first_name: string
  last_name: string
  mobile_e164: string
  email: string
}

/**
 * Looks up an existing contact by email; creates one if not found.
 * Returns the contact_id.
 *
 * full_name is a generated column on contacts — write first/last_name only.
 */
export async function upsertStrataContact(
  input: StrataContactInput
): Promise<Result<{ contact_id: string }>> {
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  const { data: existing, error: lookupError } = await supabase
    .from('contacts')
    .select('id')
    .eq('email', input.email)
    .maybeSingle()

  if (lookupError) return { ok: false, error: lookupError.message }

  if (existing) {
    // Update name + mobile in case they've changed
    const { error: updateError } = await supabase
      .from('contacts')
      .update({
        first_name: input.first_name,
        last_name: input.last_name,
        mobile_e164: input.mobile_e164,
      })
      .eq('id', existing.id)
    if (updateError) return { ok: false, error: updateError.message }
    return { ok: true, data: { contact_id: existing.id } }
  }

  const { data: created, error: createError } = await supabase
    .from('contacts')
    .insert({
      first_name: input.first_name,
      last_name: input.last_name,
      mobile_e164: input.mobile_e164,
      email: input.email,
    })
    .select('id')
    .single()

  if (createError || !created) {
    return { ok: false, error: createError?.message ?? 'Failed to create contact' }
  }
  return { ok: true, data: { contact_id: created.id } }
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

  const { data: area, error: areaError } = await supabase
    .from('collection_area')
    .select('code')
    .eq('id', collection_area_id)
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

  // Re-fetch the row to validate prereqs server-side
  const { data: row, error: fetchError } = await supabase
    .from('eligible_properties')
    .select(
      'is_mud, unit_count, strata_contact_id, auth_form_url, waste_location_notes, collection_cadence, mud_onboarding_status'
    )
    .eq('id', property_id)
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

  const { data: row, error: fetchError } = await supabase
    .from('eligible_properties')
    .select('mud_onboarding_status')
    .eq('id', property_id)
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
