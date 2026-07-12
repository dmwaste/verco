'use server'

import type { Database } from '@/lib/supabase/types'
import type { Result } from '@/lib/result'
import { verifyStaffRole } from '@/lib/auth/server'
import { OPEN_EXCEPTION_FILTER_STATUSES } from '@/lib/exceptions/status'
import { orchestrateRefund, type RefundOrchestrationState } from '@/lib/payments/orchestrate-refund'
import { REFUND_REASONS } from '@/lib/refunds/auto-raised'
import { refundStateToNotificationStatus } from '@/lib/refunds/notification-status'
import { invokeSendNotification } from '@/lib/notifications/invoke'

export async function updateNpStatus(
  npId: string,
  status: 'Under Review' | 'Resolved',
  resolutionNotes: string,
  contractorFault: boolean,
): Promise<Result<void>> {
  const auth = await verifyStaffRole()
  if (!auth) return { ok: false, error: 'Insufficient permissions.' }

  const { supabase, userId } = auth

  const update: Record<string, unknown> = {
    status,
    resolution_notes: resolutionNotes || null,
    contractor_fault: contractorFault,
  }
  if (status === 'Resolved') {
    update.resolved_at = new Date().toISOString()
    update.resolved_by = userId
  }

  // Only act on a non-terminal notice. If the row went terminal in another tab
  // the `.in(...)` matches 0 rows and we return a friendly message, instead of
  // the enforce_notice_update_rules trigger surfacing a raw Postgres error.
  const { data, error } = await supabase
    .from('nothing_presented')
    .update(update)
    .eq('id', npId)
    .in('status', [...OPEN_EXCEPTION_FILTER_STATUSES])
    .select('id')

  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) {
    return { ok: false, error: 'This record has already been resolved or rebooked.' }
  }
  return { ok: true, data: undefined }
}

export async function rebookNp(
  npId: string,
  collectionDateId: string,
  resolutionNotes: string,
  contractorFault: boolean,
): Promise<Result<{ newBookingRef: string }>> {
  const auth = await verifyStaffRole()
  if (!auth) return { ok: false, error: 'Insufficient permissions.' }

  const { supabase, userId } = auth

  const { data: np, error: npError } = await supabase
    .from('nothing_presented')
    .select(
      `id, status, booking_id, collection_stop_id,
       collection_stop:collection_stop_id(stream),
       booking:booking!nothing_presented_booking_id_fkey(
         id, ref, status, type, property_id, contact_id, collection_area_id, client_id, contractor_id, fy_id, location, notes,
         booking_item(no_services, is_extra, unit_price_cents, service_id, service!inner(waste_stream))
       )`
    )
    .eq('id', npId)
    .single()

  if (npError || !np) return { ok: false, error: 'NP record not found.' }

  if (np.status === 'Resolved' || np.status === 'Rebooked') {
    return { ok: false, error: `NP is already ${np.status}.` }
  }

  const booking = np.booking as unknown as {
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
      service: { waste_stream: string }
    }>
  }

  if (!booking) return { ok: false, error: 'Linked booking not found.' }

  // Stream-scoped rebook: an NP raised against one waste-stream's stop only
  // failed THAT pass — clone just that stream's items. Whole-booking
  // (legacy) NPs keep cloning everything. Falls back to all items if the
  // stream filter somehow matches nothing.
  const stopStream = (np.collection_stop as unknown as { stream: string } | null)?.stream
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

  const { data: collDate } = await supabase
    .from('collection_date')
    .select('id, date')
    .eq('id', collectionDateId)
    .single()

  if (!collDate) return { ok: false, error: 'Collection date not found.' }

  const { data: refData, error: refError } = await supabase
    .rpc('generate_booking_ref', { p_area_code: '' })

  const newRef = refError || !refData
    ? `RBK-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
    : refData as string

  type BookingType = Database['public']['Enums']['booking_type']

  const { data: newBooking, error: bookingError } = await supabase
    .from('booking')
    .insert({
      ref: newRef,
      status: 'Submitted',
      type: booking.type as BookingType,
      property_id: booking.property_id,
      contact_id: booking.contact_id,
      collection_area_id: booking.collection_area_id,
      client_id: booking.client_id,
      contractor_id: booking.contractor_id,
      fy_id: booking.fy_id,
      location: booking.location,
      notes: `Rebooked from ${booking.ref} (Nothing Presented)`,
    })
    .select('id, ref')
    .single()

  if (bookingError || !newBooking) {
    return { ok: false, error: bookingError?.message ?? 'Failed to create rebooked booking.' }
  }

  const newItems = itemsToClone.map((item) => ({
    booking_id: newBooking.id,
    service_id: item.service_id,
    collection_date_id: collectionDateId,
    no_services: item.no_services,
    is_extra: item.is_extra,
    unit_price_cents: contractorFault ? 0 : item.unit_price_cents,
  }))

  if (newItems.length > 0) {
    const { error: itemsError } = await supabase
      .from('booking_item')
      .insert(newItems)

    if (itemsError) {
      return { ok: false, error: `Booking created but items failed: ${itemsError.message}` }
    }
  }

  const { error: npUpdateError } = await supabase
    .from('nothing_presented')
    .update({
      status: 'Rebooked',
      resolution_notes: resolutionNotes || null,
      contractor_fault: contractorFault,
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
      rescheduled_booking_id: newBooking.id,
      rescheduled_date: collDate.date,
    })
    .eq('id', npId)

  if (npUpdateError) {
    return { ok: false, error: `Rebook created but NP update failed: ${npUpdateError.message}` }
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
      `Rebooked-status transition failed for booking ${booking.id} (NP rebook): ${rebookStatusError.message}`,
    )
  }

  return { ok: true, data: { newBookingRef: newBooking.ref } }
}

export async function resolveNpWithRefund(
  npId: string,
  resolutionNotes: string,
): Promise<Result<{ refundState: RefundOrchestrationState; refundAmountCents: number }>> {
  const auth = await verifyStaffRole()
  if (!auth) return { ok: false, error: 'Insufficient permissions.' }

  const { supabase, userId } = auth

  const { data: np } = await supabase
    .from('nothing_presented')
    .select('id, status, booking_id, booking:booking_id(id, contact_id, client_id, booking_item(unit_price_cents, no_services, is_extra))')
    .eq('id', npId)
    .single()

  if (!np) return { ok: false, error: 'NP record not found.' }

  if (np.status === 'Resolved' || np.status === 'Rebooked') {
    return { ok: false, error: `NP is already ${np.status}.` }
  }

  const { error: updateError } = await supabase
    .from('nothing_presented')
    .update({
      status: 'Resolved',
      resolution_notes: resolutionNotes || null,
      contractor_fault: true,
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
    })
    .eq('id', npId)

  if (updateError) return { ok: false, error: updateError.message }

  // Calculate refund amount from paid (extra) booking items
  const booking = np.booking as unknown as {
    id: string
    contact_id: string
    client_id: string
    booking_item: Array<{ unit_price_cents: number; no_services: number; is_extra: boolean }>
  }
  const paidItems = booking.booking_item.filter((i) => i.is_extra && i.unit_price_cents > 0)
  const refundAmountCents = paidItems.reduce((sum, i) => sum + i.unit_price_cents * i.no_services, 0)

  // NP resolved — raise + fire the refund via the shared orchestrator.
  const { state: refundState, refundRequestId } = await orchestrateRefund(supabase, {
    bookingId: booking.id,
    contactId: booking.contact_id,
    clientId: booking.client_id,
    amountCents: refundAmountCents,
    reason: REFUND_REASONS.npContractorFault,
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
      edit_ref: npId,
      refund_status: refundStatus,
      refund_request_id: refundRequestId,
    })
  }

  return { ok: true, data: { refundState, refundAmountCents } }
}
