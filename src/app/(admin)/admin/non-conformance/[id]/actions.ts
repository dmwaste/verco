'use server'

import type { Database } from '@/lib/supabase/types'
import type { Result } from '@/lib/result'
import { verifyStaffRole } from '@/lib/auth/server'
import { OPEN_EXCEPTION_FILTER_STATUSES } from '@/lib/exceptions/status'
import { orchestrateRefund, type RefundOrchestrationState } from '@/lib/payments/orchestrate-refund'
import { REFUND_REASONS } from '@/lib/refunds/auto-raised'
import { refundStateToNotificationStatus } from '@/lib/refunds/notification-status'
import { invokeSendNotification } from '@/lib/notifications/invoke'

export async function updateNcnStatus(
  ncnId: string,
  status: 'Under Review' | 'Resolved',
  resolutionNotes: string,
  contractorFault: boolean,
): Promise<Result<void>> {
  const auth = await verifyStaffRole()
  if (!auth) return { ok: false, error: 'Insufficient permissions.' }

  const { supabase, userId } = auth

  // Only act on a non-terminal notice. If the row went terminal in another tab
  // the `.in(...)` matches 0 rows and we return a friendly message, instead of
  // the enforce_notice_update_rules trigger surfacing a raw Postgres error.
  const { data, error } = await supabase
    .from('non_conformance_notice')
    .update({
      status,
      resolution_notes: resolutionNotes || null,
      contractor_fault: contractorFault,
      ...(status === 'Resolved' ? { resolved_at: new Date().toISOString(), resolved_by: userId } : {}),
    })
    .eq('id', ncnId)
    .in('status', [...OPEN_EXCEPTION_FILTER_STATUSES])
    .select('id')

  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) {
    return { ok: false, error: 'This notice has already been resolved or rebooked.' }
  }
  return { ok: true, data: undefined }
}

export async function rebookNcn(
  ncnId: string,
  collectionDateId: string,
  resolutionNotes: string,
  contractorFault: boolean,
): Promise<Result<{ newBookingRef: string }>> {
  const auth = await verifyStaffRole()
  if (!auth) return { ok: false, error: 'Insufficient permissions.' }

  const { supabase, userId } = auth

  // Fetch the NCN with its booking and items (+ the stop's stream when the
  // notice was raised against a per-stream collection stop)
  const { data: ncn, error: ncnError } = await supabase
    .from('non_conformance_notice')
    .select(
      `id, status, booking_id, collection_stop_id,
       collection_stop:collection_stop_id(stream),
       booking:booking_id(
         id, ref, status, type, property_id, contact_id, collection_area_id, client_id, contractor_id, fy_id, location, notes,
         booking_item(no_services, is_extra, unit_price_cents, service_id, service!inner(waste_stream, category(code)))
       )`
    )
    .eq('id', ncnId)
    .single()

  if (ncnError || !ncn) return { ok: false, error: 'NCN not found.' }

  // Gate on the full non-terminal set — 'Closed' (auto-close cron) is terminal
  // too; a bare Resolved/Rescheduled check would insert the clone and then die
  // on the notice trigger, stranding an orphan Confirmed booking.
  if (!(OPEN_EXCEPTION_FILTER_STATUSES as readonly string[]).includes(ncn.status)) {
    return { ok: false, error: `NCN is already ${ncn.status}.` }
  }

  const booking = ncn.booking as unknown as {
    id: string
    ref: string
    type: string
    property_id: string | null
    contact_id: string | null
    collection_area_id: string
    client_id: string
    contractor_id: string
    fy_id: string
    location: string | null
    notes: string | null
    booking_item: Array<{
      no_services: number
      is_extra: boolean
      unit_price_cents: number
      service_id: string
      service: { waste_stream: string; category: { code: string } | null }
    }>
  }

  if (!booking) return { ok: false, error: 'Linked booking not found.' }

  // Stream-scoped rebook: an NCN raised against one waste-stream's stop
  // only failed THAT pass — clone just that stream's items. Whole-booking
  // (legacy) NCNs keep cloning everything. Falls back to all items if the
  // stream filter somehow matches nothing.
  const stopStream = (ncn.collection_stop as unknown as { stream: string } | null)?.stream
  const streamItems = stopStream
    ? booking.booking_item.filter((i) => i.service.waste_stream === stopStream)
    : booking.booking_item
  const itemsToClone = streamItems.length > 0 ? streamItems : booking.booking_item

  // Stop-linked rebooks must wait until every pass for the booking is closed
  // out: the source booking is only eligible to leave 'Scheduled' once the
  // stop rollup runs, and enforce_booking_state_transition rejects
  // Scheduled→Rebooked — silently stranding the linkage if we proceeded now.
  if (stopStream) {
    const { data: pendingSiblings, error: siblingError } = await supabase
      .from('collection_stop')
      .select('id')
      .eq('booking_id', booking.id)
      .eq('status', 'Pending')
      .limit(1)
    if (siblingError) {
      return { ok: false, error: `Could not verify the booking's stops: ${siblingError.message}` }
    }
    if ((pendingSiblings ?? []).length > 0) {
      return {
        ok: false,
        error:
          'Another waste-stream pass for this booking is still pending — rebook once all passes are closed out.',
      }
    }
  }

  // Server-side date validation mirroring the dialog's filters: the date must
  // belong to THIS booking's area, be in the future (AWST — never Date#setHours,
  // see cancellation-cutoff), be open, and not closed for any bucket the cloned
  // items occupy. A stale dialog or forged call otherwise strands a Confirmed
  // rebook on a dead date that never dispatches.
  const awstToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { data: collDate } = await supabase
    .from('collection_date')
    .select('id, date, is_open, bulk_is_closed, anc_is_closed, id_is_closed')
    .eq('id', collectionDateId)
    .eq('collection_area_id', booking.collection_area_id)
    .single()

  if (!collDate) return { ok: false, error: "Collection date not found for this booking's area." }
  if (!collDate.is_open || collDate.date <= awstToday) {
    return { ok: false, error: 'That collection date is no longer available — pick an upcoming open date.' }
  }
  const closedByBucket: Record<string, boolean> = {
    bulk: collDate.bulk_is_closed,
    anc: collDate.anc_is_closed,
    id: collDate.id_is_closed,
  }
  const hitsClosedBucket = itemsToClone.some(
    (i) => i.service.category?.code && closedByBucket[i.service.category.code],
  )
  if (hitsClosedBucket) {
    return { ok: false, error: "That collection date is full for this booking's services — pick another date." }
  }

  // Generate a booking ref
  const { data: refData, error: refError } = await supabase
    .rpc('generate_booking_ref', { p_area_code: '' })

  // Fallback ref if RPC fails
  const newRef = refError || !refData
    ? `RBK-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
    : refData as string

  // Create the new booking (rebook — no payment required). Land directly in
  // 'Confirmed' (auto-confirm design): the transition-scheduled cron and the
  // T-3 OptimoRoute push only select Confirmed/Scheduled bookings, so a
  // 'Submitted' rebook would strand undispatched unless manually confirmed.
  type BookingType = Database['public']['Enums']['booking_type']

  const { data: newBooking, error: bookingError } = await supabase
    .from('booking')
    .insert({
      ref: newRef,
      status: 'Confirmed',
      type: booking.type as BookingType,
      property_id: booking.property_id,
      contact_id: booking.contact_id,
      collection_area_id: booking.collection_area_id,
      client_id: booking.client_id,
      contractor_id: booking.contractor_id,
      fy_id: booking.fy_id,
      location: booking.location,
      notes: `Rebooked from ${booking.ref} (NCN)`,
    })
    .select('id, ref')
    .single()

  if (bookingError || !newBooking) {
    return { ok: false, error: bookingError?.message ?? 'Failed to create rebooked booking.' }
  }

  // Clone booking items with the new collection date. Clones are always priced
  // at 0: a rebook is a remedy delivery, never a sale — no payment is taken on
  // this path, and the original booking keeps the real payment/refund record.
  // Cloning original prices here made a later cancel of the rebooked booking
  // auto-raise a refund_request for money never paid on it.
  const newItems = itemsToClone.map((item) => ({
    booking_id: newBooking.id,
    service_id: item.service_id,
    collection_date_id: collectionDateId,
    no_services: item.no_services,
    is_extra: item.is_extra,
    unit_price_cents: 0,
  }))

  if (newItems.length > 0) {
    const { error: itemsError } = await supabase
      .from('booking_item')
      .insert(newItems)

    if (itemsError) {
      return { ok: false, error: `Booking created but items failed: ${itemsError.message}` }
    }
  }

  // Predicated on the non-terminal set so a concurrent resolve/rebook in
  // another tab matches 0 rows instead of hitting the terminal-notice trigger.
  const { data: ncnUpdated, error: ncnUpdateError } = await supabase
    .from('non_conformance_notice')
    .update({
      status: 'Rescheduled' as Database['public']['Enums']['ncn_status'],
      resolution_notes: resolutionNotes || null,
      contractor_fault: contractorFault,
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
      rescheduled_booking_id: newBooking.id,
      rescheduled_date: collDate.date,
    })
    .eq('id', ncnId)
    .in('status', [...OPEN_EXCEPTION_FILTER_STATUSES])
    .select('id')

  if (ncnUpdateError || !ncnUpdated || ncnUpdated.length === 0) {
    // The clone already committed — cancel it (best-effort) so no orphan
    // Confirmed booking gets scheduled and dispatched for a dead rebook.
    const { error: undoError } = await supabase
      .from('booking')
      .update({ status: 'Cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', newBooking.id)
    if (undoError) {
      console.error(
        `Orphaned rebook booking ${newBooking.id} could not be cancelled after NCN update failure: ${undoError.message}`,
      )
    }
    return {
      ok: false,
      error: ncnUpdateError
        ? `Rebook created but NCN update failed: ${ncnUpdateError.message}`
        : 'This record has already been resolved or rebooked.',
    }
  }

  // Update original booking status to Rebooked. With the sibling-Pending
  // guard above this transition is always valid; log loudly if it ever
  // isn't rather than silently reporting success over a stuck booking.
  const { error: rebookStatusError } = await supabase
    .from('booking')
    .update({ status: 'Rebooked' })
    .eq('id', booking.id)
  if (rebookStatusError) {
    console.error(
      `Rebooked-status transition failed for booking ${booking.id} (NCN rebook): ${rebookStatusError.message}`,
    )
  }

  return { ok: true, data: { newBookingRef: newBooking.ref } }
}

export async function resolveWithRefund(
  ncnId: string,
  resolutionNotes: string,
): Promise<Result<{ refundState: RefundOrchestrationState; refundAmountCents: number }>> {
  const auth = await verifyStaffRole()
  if (!auth) return { ok: false, error: 'Insufficient permissions.' }

  const { supabase, userId } = auth

  // Fetch NCN with booking + paid items for refund amount
  const { data: ncn } = await supabase
    .from('non_conformance_notice')
    .select('id, status, booking_id, booking:booking_id(id, contact_id, client_id, booking_item(unit_price_cents, no_services, is_extra))')
    .eq('id', ncnId)
    .single()

  if (!ncn) return { ok: false, error: 'NCN not found.' }

  if (ncn.status === 'Resolved' || ncn.status === 'Rescheduled') {
    return { ok: false, error: `NCN is already ${ncn.status}.` }
  }

  const { error: updateError } = await supabase
    .from('non_conformance_notice')
    .update({
      status: 'Resolved' as Database['public']['Enums']['ncn_status'],
      resolution_notes: resolutionNotes || null,
      contractor_fault: true,
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
    })
    .eq('id', ncnId)

  if (updateError) return { ok: false, error: updateError.message }

  // Calculate refund amount from paid (extra) booking items
  const booking = ncn.booking as unknown as {
    id: string
    contact_id: string
    client_id: string
    booking_item: Array<{ unit_price_cents: number; no_services: number; is_extra: boolean }>
  }
  const paidItems = booking.booking_item.filter((i) => i.is_extra && i.unit_price_cents > 0)
  const refundAmountCents = paidItems.reduce((sum, i) => sum + i.unit_price_cents * i.no_services, 0)

  // NCN resolved — raise + fire the refund via the shared orchestrator.
  const { state: refundState, refundRequestId } = await orchestrateRefund(supabase, {
    bookingId: booking.id,
    contactId: booking.contact_id,
    clientId: booking.client_id,
    amountCents: refundAmountCents,
    reason: REFUND_REASONS.ncnContractorFault,
  })

  // Tell the resident WHY money landed on their card — the exact gap
  // booking_updated's docstring names ("otherwise the resident sees a refund on
  // their card with no context"). Fire ONLY when a refund was actually recorded:
  // 'failed'/'none' get no refund line and no notification (a resolution that
  // moved no money isn't resident-facing). refund_status maps via the shared
  // helper so every refund site reads identically; send-notification derives the
  // DISPLAYED amount from the refund_request row (refund_request_id), never a
  // caller-supplied figure. edit_ref = the notice id keys idempotency per
  // resolution. Fire-and-forget — a notification failure never reverts the
  // resolution (already committed above).
  const refundStatus = refundStateToNotificationStatus(refundState)
  if (refundStatus && refundRequestId) {
    await invokeSendNotification(supabase, {
      type: 'booking_updated',
      booking_id: booking.id,
      edit_ref: ncnId,
      refund_status: refundStatus,
      refund_request_id: refundRequestId,
    })
  }

  return { ok: true, data: { refundState, refundAmountCents } }
}
