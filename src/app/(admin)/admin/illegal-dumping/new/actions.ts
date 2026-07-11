'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { validateStaffRole } from '@/lib/auth/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
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

  // Enforce switcher scope server-side (issue #377 / BR-0021). collection_area
  // is public-SELECT (CLAUDE.md §21) and the RPC's own gate only checks the
  // whole accessible-client set — for a contractor-tier admin that spans every
  // client under the contractor, so a Verge-Valet-scoped admin could otherwise
  // land an ID booking on a City-of-Kwinana area. The switcher selection lives
  // in a cookie/header the DB never sees, so reject a cross-switcher area here,
  // mirroring createMudBooking (VER-281 class). A mismatched area yields no row.
  const currentClient = await getCurrentAdminClient()
  if (!currentClient) {
    return { ok: false, error: 'Select a client in the switcher to log an ID collection.' }
  }

  const { data: area, error: areaError } = await supabase
    .from('collection_area')
    .select('id')
    .eq('id', parsed.data.collection_area_id)
    .eq('client_id', currentClient.id)
    .maybeSingle()

  if (areaError) {
    return { ok: false, error: areaError.message }
  }
  if (!area) {
    return { ok: false, error: 'Collection area is outside the selected client.' }
  }

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
