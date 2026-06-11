'use server'

import { createClient } from '@/lib/supabase/server'
import { idIntakeSchema, buildIdNotes, type IdIntakeSubmission } from '@/lib/booking/id-intake'
import type { Result } from '@/lib/result'

export async function createIdBooking(
  input: IdIntakeSubmission
): Promise<Result<{ ref: string }>> {
  const supabase = await createClient()

  // Ranger-only — defence in depth; the RPC re-validates the role server-side.
  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'ranger') {
    return { ok: false, error: 'Only the ranger role can create ID bookings.' }
  }

  const parsed = idIntakeSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }

  // Atomic, advisory-locked creation. The RPC validates ranger scope, derives
  // tenant from the area, checks ID capacity, and lands the booking in
  // 'Confirmed' so the daily cron schedules it onto the run sheet.
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

  const ref = (data as { ref?: string } | null)?.ref
  if (!ref) {
    return { ok: false, error: 'Booking created but no reference was returned.' }
  }

  return { ok: true, data: { ref } }
}
