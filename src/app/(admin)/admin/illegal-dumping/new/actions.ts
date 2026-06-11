'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { validateStaffRole } from '@/lib/auth/server'
import { idIntakeSchema, buildIdNotes, type IdIntakeSubmission } from '@/lib/booking/id-intake'
import type { Result } from '@/lib/result'

export async function createAdminIdBooking(
  input: IdIntakeSubmission
): Promise<Result<{ ref: string; bookingId: string }>> {
  // Staff-only — defence in depth; the RPC re-validates the role server-side.
  const roleCheck = await validateStaffRole()
  if (!roleCheck.ok) {
    return { ok: false, error: roleCheck.error }
  }

  // Office intake requires a non-empty address (the field/GPS flow may
  // legitimately submit coordinates with a blank address, so the shared
  // schema doesn't enforce it).
  const adminSchema = idIntakeSchema.extend({
    geo_address: z.string().trim().min(1, 'Address is required').max(500),
  })
  const parsed = adminSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }

  const supabase = await createClient()

  // Atomic, advisory-locked creation. The RPC validates the caller's role,
  // tenant/sub-client scope and date validity, derives tenant from the area,
  // checks ID capacity, and lands the booking in 'Confirmed' so the daily
  // cron schedules it onto the run sheet.
  const { data, error } = await supabase.rpc(
    'create_id_booking_with_capacity_check',
    {
      p_collection_date_id: parsed.data.collection_date_id,
      p_collection_area_id: parsed.data.collection_area_id,
      p_latitude: parsed.data.latitude,
      p_longitude: parsed.data.longitude,
      p_geo_address: parsed.data.geo_address,
      p_notes: buildIdNotes(parsed.data.description, parsed.data.notes),
      p_photos: parsed.data.photo_urls,
      p_waste_types: parsed.data.waste_types,
      p_volume: parsed.data.volume,
    }
  )

  if (error) {
    return { ok: false, error: error.message }
  }

  const result = data as { ref?: string; booking_id?: string } | null
  if (!result?.ref || !result.booking_id) {
    return { ok: false, error: 'Booking created but no reference was returned.' }
  }

  return { ok: true, data: { ref: result.ref, bookingId: result.booking_id } }
}
