'use server'

import { createClient } from '@/lib/supabase/server'
import { invokeSendNotification } from '@/lib/notifications/invoke'
import type { Database } from '@/lib/supabase/types'
import type { Result } from '@/lib/result'

type NcnReason = Database['public']['Enums']['ncn_reason']

async function validateFieldRole(): Promise<Result<string>> {
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  if (!role || !['field', 'ranger'].includes(role)) {
    return { ok: false, error: 'Insufficient permissions. Field role required.' }
  }
  return { ok: true, data: role }
}

/**
 * Legacy guard (mixed-mode window): once a booking has per-stream stops,
 * the whole-booking closeout path is closed — closing the booking directly
 * would race the stop rollup and strand sibling streams. Crews work stops
 * from the Runs tab instead.
 */
async function bookingHasStops(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bookingId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('collection_stop')
    .select('id')
    .eq('booking_id', bookingId)
    .limit(1)
  // Fail CLOSED: a transient query error must not let the whole-booking
  // path proceed on a stop-model booking.
  if (error) return true
  return (data ?? []).length > 0
}

const STOPS_GUARD_ERROR =
  'This booking is closed out per waste stream — open it from the Runs tab instead.'

/**
 * Per brief Q2 (2026-04-08): MUD bookings cannot transition to Completed,
 * Non-conformance, or Nothing Presented until every booking_item has
 * actual_services set. The crew enters the count first, then picks the
 * transition. Returns ok=false with a clear error if the gate fails.
 *
 * SUD bookings always pass this check.
 */
async function assertMudActualServicesSet(bookingId: string): Promise<Result<void>> {
  const supabase = await createClient()
  const { data: booking } = await supabase
    .from('booking')
    .select('id, type, booking_item(actual_services)')
    .eq('id', bookingId)
    .single()
  if (!booking) return { ok: false, error: 'Booking not found.' }
  if (booking.type !== 'MUD') return { ok: true, data: undefined }
  const items = booking.booking_item as Array<{ actual_services: number | null }> | null
  if (!items || items.length === 0) {
    return { ok: false, error: 'MUD booking has no items to complete.' }
  }
  const missing = items.filter((i) => i.actual_services === null || i.actual_services === undefined)
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Enter the actual collected count for every service before closing this MUD booking (${missing.length} missing).`,
    }
  }
  return { ok: true, data: undefined }
}

export async function completeBooking(bookingId: string): Promise<Result<void>> {
  const roleCheck = await validateFieldRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  const { data: booking } = await supabase
    .from('booking')
    .select('id, status, client_id')
    .eq('id', bookingId)
    .single()

  if (!booking) return { ok: false, error: 'Booking not found.' }
  if (booking.status !== 'Scheduled') {
    return { ok: false, error: `Cannot complete a booking with status "${booking.status}".` }
  }

  if (await bookingHasStops(supabase, bookingId)) {
    return { ok: false, error: STOPS_GUARD_ERROR }
  }

  const mudGate = await assertMudActualServicesSet(bookingId)
  if (!mudGate.ok) return mudGate

  const { error } = await supabase
    .from('booking')
    .update({ status: 'Completed' })
    .eq('id', bookingId)

  if (error) return { ok: false, error: error.message }

  // Create survey + fire completion notification. client_id comes from the
  // booking row, NOT the x-client-id header — the field host
  // (field.verco.au) never sets that header, so deriving it from the row is
  // the only path that works on every host.
  const surveyToken = crypto.randomUUID()
  const { error: surveyError } = await supabase
    .from('booking_survey')
    .insert({
      booking_id: bookingId,
      client_id: booking.client_id,
      token: surveyToken,
    })

  if (surveyError) {
    console.error('Failed to create booking_survey:', surveyError.message)
  } else {
    await invokeSendNotification(supabase, {
      type: 'completion_survey',
      booking_id: bookingId,
      survey_token: surveyToken,
    })
  }

  return { ok: true, data: undefined }
}

export async function raiseNcn(
  bookingId: string,
  reason: NcnReason,
  notes: string,
  photoUrls: string[]
): Promise<Result<void>> {
  const roleCheck = await validateFieldRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  // client_id from the booking row, not x-client-id — the field host never
  // sets that header (it only sets x-contractor-id).
  const { data: booking } = await supabase
    .from('booking')
    .select('id, status, client_id')
    .eq('id', bookingId)
    .single()

  if (!booking) return { ok: false, error: 'Booking not found.' }
  if (booking.status !== 'Scheduled') {
    return { ok: false, error: `Cannot raise NCN for a booking with status "${booking.status}".` }
  }

  if (await bookingHasStops(supabase, bookingId)) {
    return { ok: false, error: STOPS_GUARD_ERROR }
  }

  const mudGate = await assertMudActualServicesSet(bookingId)
  if (!mudGate.ok) return mudGate

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Insert non_conformance_notice
  const { data: ncnRow, error: ncnError } = await supabase
    .from('non_conformance_notice')
    .insert({
      booking_id: bookingId,
      client_id: booking.client_id,
      reason,
      notes: notes || null,
      photos: photoUrls,
      reported_by: user?.id ?? null,
      reported_at: new Date().toISOString(),
      status: 'Issued',
    })
    .select('id')
    .single()

  if (ncnError) return { ok: false, error: ncnError.message }

  // Transition booking status
  const { error: updateError } = await supabase
    .from('booking')
    .update({ status: 'Non-conformance' })
    .eq('id', bookingId)

  if (updateError) return { ok: false, error: updateError.message }

  // Fire NCN notification — fire-and-forget
  await invokeSendNotification(supabase, {
    type: 'ncn_raised',
    booking_id: bookingId,
    ncn_id: ncnRow?.id ?? '',
    reason,
    notes: notes || undefined,
    photos: photoUrls.length > 0 ? photoUrls : undefined,
  })

  return { ok: true, data: undefined }
}

export async function raiseNothingPresented(
  bookingId: string,
  notes: string,
  photoUrls: string[],
  dmFault: boolean
): Promise<Result<void>> {
  const roleCheck = await validateFieldRole()
  if (!roleCheck.ok) return roleCheck

  const supabase = await createClient()

  // client_id from the booking row, not x-client-id — the field host never
  // sets that header (it only sets x-contractor-id).
  const { data: booking } = await supabase
    .from('booking')
    .select('id, status, client_id')
    .eq('id', bookingId)
    .single()

  if (!booking) return { ok: false, error: 'Booking not found.' }
  if (booking.status !== 'Scheduled') {
    return { ok: false, error: `Cannot raise NP for a booking with status "${booking.status}".` }
  }

  if (await bookingHasStops(supabase, bookingId)) {
    return { ok: false, error: STOPS_GUARD_ERROR }
  }

  const mudGate = await assertMudActualServicesSet(bookingId)
  if (!mudGate.ok) return mudGate

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: npRow, error: npError } = await supabase
    .from('nothing_presented')
    .insert({
      booking_id: bookingId,
      client_id: booking.client_id,
      notes: notes || null,
      photos: photoUrls,
      contractor_fault: dmFault,
      reported_by: user?.id ?? null,
      reported_at: new Date().toISOString(),
      status: 'Issued',
    })
    .select('id')
    .single()

  if (npError) return { ok: false, error: npError.message }

  const { error: updateError } = await supabase
    .from('booking')
    .update({ status: 'Nothing Presented' })
    .eq('id', bookingId)

  if (updateError) return { ok: false, error: updateError.message }

  // Fire NP notification — fire-and-forget
  await invokeSendNotification(supabase, {
    type: 'np_raised',
    booking_id: bookingId,
    np_id: npRow?.id ?? '',
    notes: notes || undefined,
    photos: photoUrls.length > 0 ? photoUrls : undefined,
    contractor_fault: dmFault,
  })

  return { ok: true, data: undefined }
}

/**
 * Persists actual_services counts for one or more booking_items belonging to
 * the same booking. Does NOT transition the booking status — the crew picks
 * the transition (Complete/NCN/NP) afterwards via the standard close-out
 * actions, each of which calls assertMudActualServicesSet() server-side.
 *
 * Per brief Q2 (2026-04-08) all three completion paths require counts.
 */
export async function saveMudActualServices(
  bookingId: string,
  counts: Array<{ booking_item_id: string; actual_count: number }>
): Promise<Result<void>> {
  const roleCheck = await validateFieldRole()
  if (!roleCheck.ok) return roleCheck

  if (counts.length === 0) {
    return { ok: false, error: 'No counts to save.' }
  }
  for (const c of counts) {
    if (!Number.isInteger(c.actual_count) || c.actual_count < 0) {
      return { ok: false, error: 'Each count must be 0 or greater.' }
    }
  }

  const supabase = await createClient()

  // Single round-trip: ownership check + bulk UPDATE inside one RPC under
  // the caller's role (RLS gates SELECT/UPDATE on booking_item).
  // Tampered client payloads are rejected SQL-side by the ownership join.
  const updates = counts.map((c) => ({
    id: c.booking_item_id,
    actual_count: c.actual_count,
  }))
  const { error } = await supabase.rpc('bulk_update_booking_item_actuals', {
    p_booking_id: bookingId,
    p_updates: updates,
  })
  if (error) return { ok: false, error: error.message }

  return { ok: true, data: undefined }
}