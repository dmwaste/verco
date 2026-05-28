'use server'

import type { Database } from '@/lib/supabase/types'
import type { Result } from '@/lib/result'
import { verifyStaffRole } from '@/lib/auth/server'

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

  const { error } = await supabase
    .from('nothing_presented')
    .update(update)
    .eq('id', npId)

  if (error) return { ok: false, error: error.message }
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
      `id, status, booking_id,
       booking:booking!nothing_presented_booking_id_fkey(
         id, ref, status, type, property_id, contact_id, collection_area_id, client_id, contractor_id, fy_id, location, notes,
         booking_item(no_services, is_extra, unit_price_cents, service_id)
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
    }>
  }

  if (!booking) return { ok: false, error: 'Linked booking not found.' }

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

  const newItems = booking.booking_item.map((item) => ({
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

  // Update original booking status to Rebooked
  await supabase
    .from('booking')
    .update({ status: 'Rebooked' })
    .eq('id', booking.id)

  return { ok: true, data: { newBookingRef: newBooking.ref } }
}

export async function resolveNpWithRefund(
  npId: string,
  resolutionNotes: string,
): Promise<Result<void>> {
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

  if (refundAmountCents > 0) {
    // Create refund_request record
    const { data: refundReq, error: refundInsertError } = await supabase
      .from('refund_request')
      .insert({
        booking_id: booking.id,
        contact_id: booking.contact_id,
        client_id: booking.client_id,
        amount_cents: refundAmountCents,
        reason: 'Contractor fault — Nothing Presented resolution',
        status: 'Pending',
      })
      .select('id')
      .single()

    if (refundInsertError || !refundReq) {
      console.error('Failed to create refund_request:', refundInsertError?.message)
      return { ok: true, data: undefined }
    }

    // Trigger refund via process-refund Edge Function
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/process-refund`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ refund_request_id: refundReq.id }),
        }
      )

      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error')
        console.error(`Refund trigger failed for booking ${booking.id}: ${errText}`)
      }
    }
  }

  return { ok: true, data: undefined }
}
