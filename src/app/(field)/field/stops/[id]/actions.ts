'use server'

import { createClient } from '@/lib/supabase/server'
import { invokeSendNotification } from '@/lib/notifications/invoke'
import { STREAM_LABEL } from '@/lib/stops/labels'
import type { WasteStream } from '@/lib/stops/stops'
import type { Database } from '@/lib/supabase/types'
import type { Result } from '@/lib/result'

type NcnReason = Database['public']['Enums']['ncn_reason']
type StopTerminalStatus = 'Completed' | 'Non-conformance' | 'Nothing Presented'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * Per-stop closeout actions (stop = booking × waste stream). These mirror
 * the legacy per-booking actions in ../../booking/[ref]/actions.ts but
 * terminalise ONE stream's stop; the DB trigger
 * `rollup_booking_status_from_stops` derives the booking status once every
 * sibling stop is terminal (exception wins: NCN > NP > Completed).
 *
 * Stop closeout is crew-only: the collection_stop UPDATE policy is
 * has_role('field') — rangers raise IDs but never work runs.
 */
async function validateFieldOnly(supabase: SupabaseServerClient): Promise<Result<void>> {
  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'field') {
    return { ok: false, error: 'Insufficient permissions. Field role required.' }
  }
  return { ok: true, data: undefined }
}

interface GuardedStop {
  id: string
  stream: WasteStream
  booking_id: string
  client_id: string
  booking: { id: string; ref: string; status: string; type: string }
}

async function loadStopGuarded(
  supabase: SupabaseServerClient,
  stopId: string,
): Promise<Result<GuardedStop>> {
  const { data: stop } = await supabase
    .from('collection_stop')
    .select('id, stream, status, booking_id, client_id, booking:booking_id(id, ref, status, type)')
    .eq('id', stopId)
    .single()

  if (!stop) return { ok: false, error: 'Stop not found.' }
  if (stop.status !== 'Pending') {
    return { ok: false, error: `This stop is already ${stop.status}.` }
  }
  const booking = stop.booking as unknown as GuardedStop['booking']
  if (booking.status !== 'Scheduled') {
    return {
      ok: false,
      error: `Cannot close out a stop while the booking is "${booking.status}".`,
    }
  }
  return {
    ok: true,
    data: {
      id: stop.id,
      stream: stop.stream,
      booking_id: stop.booking_id,
      client_id: stop.client_id,
      booking,
    },
  }
}

/**
 * Per-stream MUD gate: only the items belonging to THIS stop's stream need
 * actual_services before the stream can close — the other pass enters its
 * own counts when its crew works the stop.
 */
async function assertMudStreamCounts(
  supabase: SupabaseServerClient,
  bookingId: string,
  stream: WasteStream,
): Promise<Result<void>> {
  const { data: items } = await supabase
    .from('booking_item')
    .select('id, actual_services, service!inner(waste_stream)')
    .eq('booking_id', bookingId)

  const streamItems = (items ?? []).filter(
    (i) => (i.service as unknown as { waste_stream: WasteStream }).waste_stream === stream,
  )
  const missing = streamItems.filter(
    (i) => i.actual_services === null || i.actual_services === undefined,
  )
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Enter the actual collected count for every ${STREAM_LABEL[stream]} service before closing this stop (${missing.length} missing).`,
    }
  }
  return { ok: true, data: undefined }
}

/**
 * Pending → terminal stop transition. The state-machine trigger requires
 * `completed_by = auth.uid()` for non-privileged writers; the `.eq('status',
 * 'Pending')` + row-count check guards the silent-0-row RLS no-op (a sibling
 * crew member may have just closed the same stop).
 */
async function terminaliseStop(
  supabase: SupabaseServerClient,
  stopId: string,
  status: StopTerminalStatus,
  userId: string,
): Promise<Result<void>> {
  const { data: updated, error } = await supabase
    .from('collection_stop')
    .update({
      status,
      completed_at: new Date().toISOString(),
      completed_by: userId,
    })
    .eq('id', stopId)
    .eq('status', 'Pending')
    .select('id')

  if (error) return { ok: false, error: error.message }
  if (!updated || updated.length === 0) {
    return {
      ok: false,
      error: 'Stop could not be updated — it may have just been closed by someone else.',
    }
  }
  return { ok: true, data: undefined }
}

/**
 * Completion survey fires only when the FINAL stop closes and the rollup
 * lands on Completed (locked decision 10/06/2026: immediate exceptions,
 * survey at end). The existence check guards the race where two crews close
 * sibling stops near-simultaneously and both observe the rolled-up booking.
 */
async function maybeCreateCompletionSurvey(
  supabase: SupabaseServerClient,
  bookingId: string,
  clientId: string,
): Promise<void> {
  const { data: booking } = await supabase
    .from('booking')
    .select('status')
    .eq('id', bookingId)
    .single()
  if (booking?.status !== 'Completed') return

  const { data: existing } = await supabase
    .from('booking_survey')
    .select('id')
    .eq('booking_id', bookingId)
    .limit(1)
  if (existing && existing.length > 0) return

  const surveyToken = crypto.randomUUID()
  const { error: surveyError } = await supabase.from('booking_survey').insert({
    booking_id: bookingId,
    client_id: clientId,
    token: surveyToken,
  })
  if (surveyError) {
    console.error('Failed to create booking_survey:', surveyError.message)
    return
  }
  await invokeSendNotification(supabase, {
    type: 'completion_survey',
    booking_id: bookingId,
    survey_token: surveyToken,
  })
}

export async function completeStop(stopId: string): Promise<Result<void>> {
  const supabase = await createClient()

  const roleCheck = await validateFieldOnly(supabase)
  if (!roleCheck.ok) return roleCheck

  const stopCheck = await loadStopGuarded(supabase, stopId)
  if (!stopCheck.ok) return stopCheck
  const stop = stopCheck.data

  if (stop.booking.type === 'MUD') {
    const mudGate = await assertMudStreamCounts(supabase, stop.booking_id, stop.stream)
    if (!mudGate.ok) return mudGate
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const updated = await terminaliseStop(supabase, stop.id, 'Completed', user.id)
  if (!updated.ok) return updated

  await maybeCreateCompletionSurvey(supabase, stop.booking_id, stop.client_id)

  return { ok: true, data: undefined }
}

export async function raiseNcnForStop(
  stopId: string,
  reason: NcnReason,
  notes: string,
  photoUrls: string[],
): Promise<Result<void>> {
  const supabase = await createClient()

  const roleCheck = await validateFieldOnly(supabase)
  if (!roleCheck.ok) return roleCheck

  const stopCheck = await loadStopGuarded(supabase, stopId)
  if (!stopCheck.ok) return stopCheck
  const stop = stopCheck.data

  if (stop.booking.type === 'MUD') {
    const mudGate = await assertMudStreamCounts(supabase, stop.booking_id, stop.stream)
    if (!mudGate.ok) return mudGate
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  // Record first, then transition — same order as the legacy per-booking
  // path: a reason-less NCN'd stop is worse than an orphan Issued notice.
  const { data: ncnRow, error: ncnError } = await supabase
    .from('non_conformance_notice')
    .insert({
      booking_id: stop.booking_id,
      client_id: stop.client_id,
      collection_stop_id: stop.id,
      reason,
      notes: notes || null,
      photos: photoUrls,
      reported_by: user.id,
      reported_at: new Date().toISOString(),
      status: 'Issued',
    })
    .select('id')
    .single()

  if (ncnError) return { ok: false, error: ncnError.message }

  const updated = await terminaliseStop(supabase, stop.id, 'Non-conformance', user.id)
  if (!updated.ok) return updated

  // Immediate per-stop comms, stream named (locked decision 10/06/2026).
  await invokeSendNotification(supabase, {
    type: 'ncn_raised',
    booking_id: stop.booking_id,
    ncn_id: ncnRow?.id ?? '',
    reason,
    notes: notes || undefined,
    photos: photoUrls.length > 0 ? photoUrls : undefined,
    stream: STREAM_LABEL[stop.stream],
  })

  return { ok: true, data: undefined }
}

export async function raiseNpForStop(
  stopId: string,
  notes: string,
  photoUrls: string[],
  dmFault: boolean,
): Promise<Result<void>> {
  const supabase = await createClient()

  const roleCheck = await validateFieldOnly(supabase)
  if (!roleCheck.ok) return roleCheck

  const stopCheck = await loadStopGuarded(supabase, stopId)
  if (!stopCheck.ok) return stopCheck
  const stop = stopCheck.data

  if (stop.booking.type === 'MUD') {
    const mudGate = await assertMudStreamCounts(supabase, stop.booking_id, stop.stream)
    if (!mudGate.ok) return mudGate
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const { data: npRow, error: npError } = await supabase
    .from('nothing_presented')
    .insert({
      booking_id: stop.booking_id,
      client_id: stop.client_id,
      collection_stop_id: stop.id,
      notes: notes || null,
      photos: photoUrls,
      contractor_fault: dmFault,
      reported_by: user.id,
      reported_at: new Date().toISOString(),
      status: 'Issued',
    })
    .select('id')
    .single()

  if (npError) return { ok: false, error: npError.message }

  const updated = await terminaliseStop(supabase, stop.id, 'Nothing Presented', user.id)
  if (!updated.ok) return updated

  await invokeSendNotification(supabase, {
    type: 'np_raised',
    booking_id: stop.booking_id,
    np_id: npRow?.id ?? '',
    notes: notes || undefined,
    photos: photoUrls.length > 0 ? photoUrls : undefined,
    contractor_fault: dmFault,
    stream: STREAM_LABEL[stop.stream],
  })

  return { ok: true, data: undefined }
}
