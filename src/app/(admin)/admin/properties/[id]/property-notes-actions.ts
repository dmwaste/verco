'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { Result } from '@/lib/result'
import { err, ok } from '@/lib/result'
import { validateStaffRole } from '@/lib/auth/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { assertRowsAffected } from '@/lib/db/assert-rows-affected'
import {
  PROPERTY_DOCUMENTS_BUCKET,
  addPropertyNoteSchema,
  buildDocumentPath,
  isPathForProperty,
  uploadRequestSchema,
  type AddPropertyNoteInput,
} from '@/lib/property-notes/validation'

/**
 * Property notes & documents (ADR 0031). RLS on property_note and the
 * property-documents bucket is the authority (staff + tenant + sub-client);
 * these actions add the current-admin-client pin (VER-281: eligible_properties
 * is public-SELECT, so RLS alone doesn't scope a property read). File links
 * are signed by the page from RLS-scoped rows — no action signs a raw path.
 */

type SupabaseServer = Awaited<ReturnType<typeof createClient>>

const noteIdSchema = z.string().uuid()

/** The property, but only inside the client the admin is currently working in. */
async function propertyInCurrentClient(
  supabase: SupabaseServer,
  propertyId: string,
): Promise<Result<{ clientId: string }>> {
  const client = await getCurrentAdminClient()
  if (!client) return err('No client selected.')

  const { data, error } = await supabase
    .from('eligible_properties')
    .select('id, collection_area!inner(client_id)')
    .eq('id', propertyId)
    .eq('collection_area.client_id', client.id)
    .maybeSingle()

  if (error) return err(error.message)
  if (!data) return err('Property not found.')
  return ok({ clientId: client.id })
}

export async function createPropertyDocumentUploadUrl(input: {
  propertyId: string
  fileName: string
  fileType: string
  fileSize: number
}): Promise<Result<{ path: string; token: string }>> {
  const parsed = uploadRequestSchema.safeParse(input)
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Invalid file.')

  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()
  const scope = await propertyInCurrentClient(supabase, parsed.data.propertyId)
  if (!scope.ok) return scope

  const path = buildDocumentPath(
    scope.data.clientId,
    parsed.data.propertyId,
    parsed.data.fileName,
    crypto.randomUUID(),
  )

  const { data, error } = await supabase.storage
    .from(PROPERTY_DOCUMENTS_BUCKET)
    .createSignedUploadUrl(path)

  if (error || !data) return err(error?.message ?? 'Could not start the upload.')
  return ok({ path: data.path, token: data.token })
}

export async function addPropertyNote(input: AddPropertyNoteInput): Promise<Result<{ id: string }>> {
  const parsed = addPropertyNoteSchema.safeParse(input)
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Invalid note.')
  const { propertyId, kind, body, file } = parsed.data

  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()
  const scope = await propertyInCurrentClient(supabase, propertyId)
  if (!scope.ok) return scope

  // The file must be one uploaded for THIS property — never point a note at
  // another property's (or tenant's) object.
  if (file && !isPathForProperty(file.path, scope.data.clientId, propertyId)) {
    return err('That file does not belong to this property.')
  }

  const { data, error } = await supabase
    .from('property_note')
    .insert({
      property_id: propertyId,
      // Overwritten by the property_note_set_client_id trigger; passed because
      // the column is NOT NULL in the generated Insert type.
      client_id: scope.data.clientId,
      kind,
      body: body ?? null,
      file_path: file?.path ?? null,
      file_name: file?.name ?? null,
      file_type: file?.type ?? null,
      file_size: file?.size ?? null,
    })
    .select('id')
    .single()

  if (error || !data) return err(error?.message ?? 'Could not save the note.')
  return ok({ id: data.id })
}

/** Hides an entry; the row and its file are kept for the record (ADR 0031). */
export async function removePropertyNote(noteId: string): Promise<Result<{ id: string }>> {
  if (!noteIdSchema.safeParse(noteId).success) return err('Invalid note.')

  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) return roleCheck

  const client = await getCurrentAdminClient()
  if (!client) return err('No client selected.')

  const supabase = await createClient()
  // removed_by is stamped by the property_note_enforce_removal_only trigger.
  const { data, error } = await supabase
    .from('property_note')
    .update({ removed_at: new Date().toISOString() })
    .eq('id', noteId)
    .eq('client_id', client.id)
    .is('removed_at', null)
    .select('id')

  const result = assertRowsAffected(data, error, 'Note not found or already removed.')
  if (!result.ok) return result
  return ok({ id: noteId })
}
