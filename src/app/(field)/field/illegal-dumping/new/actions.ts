'use server'

import { createClient } from '@/lib/supabase/server'

type Result<T, E = string> =
  | { ok: true; data: T }
  | { ok: false; error: E }

interface CreateIdBookingInput {
  latitude: number
  longitude: number
  geo_address: string
  collection_date_id: string
  collection_area_id: string
  waste_types: string[]
  volume: string
  description: string
  photo_urls: string[]
  notes: string
}

export async function createIdBooking(
  input: CreateIdBookingInput
): Promise<Result<{ ref: string }>> {
  const supabase = await createClient()

  // Ranger-only — defence in depth; the RPC re-validates the role server-side.
  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'ranger') {
    return { ok: false, error: 'Only the ranger role can create ID bookings.' }
  }

  // Waste types, volume and photos now persist in dedicated columns. The notes
  // column carries only the two free-text fields.
  const notes = [input.description, input.notes]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')

  // Atomic, advisory-locked creation. The RPC validates ranger scope, derives
  // tenant from the area, checks ID capacity, and lands the booking in
  // 'Confirmed' so the daily cron schedules it onto the run sheet.
  const { data, error } = await supabase.rpc(
    'create_id_booking_with_capacity_check',
    {
      p_collection_date_id: input.collection_date_id,
      p_collection_area_id: input.collection_area_id,
      p_latitude: input.latitude,
      p_longitude: input.longitude,
      p_geo_address: input.geo_address,
      p_notes: notes,
      p_photos: input.photo_urls,
      p_waste_types: input.waste_types,
      p_volume: input.volume,
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
