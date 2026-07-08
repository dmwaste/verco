'use server'

import { z } from 'zod'
import * as Sentry from '@sentry/nextjs'
import { createClient } from '@/lib/supabase/server'
import { invokeSendNotification } from '@/lib/notifications/invoke'
import { NCN_REASONS } from '@/lib/ncn/reasons'
import { STREAM_LABEL } from '@/lib/stops/labels'
import { serviceLabelFromSummary, STOP_CLOSEOUT_SELECT } from '@/lib/stops/service-label'
import type { WasteStream } from '@/lib/stops/stops'
import type { Database, Json } from '@/lib/supabase/types'
import type { Result } from '@/lib/result'

type NcnReason = Database['public']['Enums']['ncn_reason']
type StopTerminalStatus = 'Completed' | 'Non-conformance' | 'Nothing Presented'

const stopIdSchema = z.string().uuid()

// Photos must be evidence the crew actually uploaded — a field JWT must not
// be able to inject arbitrary external URLs into a resident-facing email.
const storagePublicPrefix = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/`
const closeoutDetailsSchema = z.object({
  notes: z.string().max(2000),
  photoUrls: z
    .array(
      z
        .string()
        .url()
        .refine((u) => u.startsWith(storagePublicPrefix), {
          message: 'Photos must be uploaded evidence.',
        }),
    )
    .max(8),
})
const ncnReasonSchema = z.enum(NCN_REASONS)

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
  services_summary: Json
  booking: { id: string; ref: string; status: string; type: string }
}

async function loadStopGuarded(
  supabase: SupabaseServerClient,
  stopId: string,
): Promise<Result<GuardedStop>> {
  const { data: stop } = await supabase
    .from('collection_stop')
    .select(STOP_CLOSEOUT_SELECT)
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
      services_summary: stop.services_summary,
      booking,
    },
  }
}

/**
 * Resident-facing "Service type" label for a stop's notice. Reads the stop's
 * `services_summary` (populated by the push EF, 100% in prod today but enforced
 * nowhere) and emits a loud Sentry warning if it has to fall back — so a
 * silently-empty summary surfaces instead of quietly reverting to a stream
 * label. Booking id only; no PII.
 */
function stopServiceLabel(stop: GuardedStop): string {
  const { label, fromFallback } = serviceLabelFromSummary(stop.services_summary, stop.stream)
  if (fromFallback) {
    Sentry.captureMessage('NCN/NP notice fell back to stream label (empty services_summary)', {
      level: 'warning',
      extra: { booking_id: stop.booking_id, stop_id: stop.id, stream: stop.stream },
    })
  }
  return label
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
  const { data: items, error } = await supabase
    .from('booking_item')
    .select('id, actual_services, service!inner(waste_stream)')
    .eq('booking_id', bookingId)

  // Fail CLOSED: the server action is the only line of defence for the
  // counts rule — a swallowed query error must not let a MUD stop close
  // with actual_services still NULL.
  if (error) {
    return { ok: false, error: `Could not verify MUD counts: ${error.message}` }
  }

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
  // E1 safety valve (plan decision D1): pause survey creation + the completion
  // email during go-live. Set DISABLE_SURVEY_EMAIL=true in the runtime env to
  // hold surveys (e.g. before the end-to-end staging verify is done); unset it
  // to resume normal operation. Default (unset) = surveys on.
  if (process.env.DISABLE_SURVEY_EMAIL === 'true') return

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
  if (!stopIdSchema.safeParse(stopId).success) {
    return { ok: false, error: 'Invalid stop reference.' }
  }

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
  if (!stopIdSchema.safeParse(stopId).success) {
    return { ok: false, error: 'Invalid stop reference.' }
  }
  if (!ncnReasonSchema.safeParse(reason).success) {
    return { ok: false, error: 'Please select a valid reason.' }
  }
  const details = closeoutDetailsSchema.safeParse({ notes, photoUrls })
  if (!details.success) {
    return { ok: false, error: details.error.issues[0]?.message ?? 'Invalid input.' }
  }

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
  // The terminalise-failure branch below compensates by deleting the notice.
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
  if (!updated.ok) {
    // Lost the closeout race (another crew just closed this stop) — remove
    // the orphan Issued notice or an admin could action both notices and
    // double-book the same stream. Delete policy: own Issued notices only.
    const { data: deleted, error: deleteError } = await supabase
      .from('non_conformance_notice')
      .delete()
      .eq('id', ncnRow.id)
      .select('id')
    if (deleteError || !deleted || deleted.length === 0) {
      console.error(
        `NCN compensation delete failed for ${ncnRow.id}: ${deleteError?.message ?? '0 rows'}`,
      )
      return {
        ok: false,
        error: `${updated.error} A duplicate notice may have been recorded — mention it to your supervisor.`,
      }
    }
    return updated
  }

  // Immediate per-stop comms, booked service(s) named (locked 10/06/2026;
  // stream label → service names 08/07/2026). Payload key stays `stream`.
  await invokeSendNotification(supabase, {
    type: 'ncn_raised',
    booking_id: stop.booking_id,
    ncn_id: ncnRow?.id ?? '',
    reason,
    notes: notes || undefined,
    photos: photoUrls.length > 0 ? photoUrls : undefined,
    stream: stopServiceLabel(stop),
  })

  return { ok: true, data: undefined }
}

export async function raiseNpForStop(
  stopId: string,
  notes: string,
  photoUrls: string[],
  dmFault: boolean,
): Promise<Result<void>> {
  if (!stopIdSchema.safeParse(stopId).success) {
    return { ok: false, error: 'Invalid stop reference.' }
  }
  const details = closeoutDetailsSchema.safeParse({ notes, photoUrls })
  if (!details.success) {
    return { ok: false, error: details.error.issues[0]?.message ?? 'Invalid input.' }
  }

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
  if (!updated.ok) {
    // Same compensation as the NCN path — see comment there.
    const { data: deleted, error: deleteError } = await supabase
      .from('nothing_presented')
      .delete()
      .eq('id', npRow.id)
      .select('id')
    if (deleteError || !deleted || deleted.length === 0) {
      console.error(
        `NP compensation delete failed for ${npRow.id}: ${deleteError?.message ?? '0 rows'}`,
      )
      return {
        ok: false,
        error: `${updated.error} A duplicate notice may have been recorded — mention it to your supervisor.`,
      }
    }
    return updated
  }

  await invokeSendNotification(supabase, {
    type: 'np_raised',
    booking_id: stop.booking_id,
    np_id: npRow?.id ?? '',
    notes: notes || undefined,
    photos: photoUrls.length > 0 ? photoUrls : undefined,
    contractor_fault: dmFault,
    stream: stopServiceLabel(stop),
  })

  return { ok: true, data: undefined }
}
