'use server'

import { createClient } from '@/lib/supabase/server'
import { invokeSendNotification } from '@/lib/notifications/invoke'
import { assertRowsAffected } from '@/lib/db/assert-rows-affected'
import { isPastCancellationCutoff } from '@/lib/booking/cancellation-cutoff'
import { REFUND_REASONS } from '@/lib/refunds/auto-raised'
import type { Result } from '@/lib/result'

/**
 * Cancel a booking. Checks the cancellation cutoff (3:30pm AWST day before
 * collection) before proceeding. RLS ensures the user can only cancel their
 * own bookings.
 */
export async function cancelBooking(bookingId: string): Promise<Result<void>> {
  if (!bookingId) {
    return { ok: false, error: 'Booking ID is required.' }
  }

  const supabase = await createClient()

  // Fetch the booking to check its current status and collection date
  const { data: booking, error: fetchError } = await supabase
    .from('booking')
    .select(
      'id, status, contact_id, client_id, booking_item(unit_price_cents, no_services, is_extra, collection_date!inner(date))'
    )
    .eq('id', bookingId)
    .single()

  if (fetchError || !booking) {
    return { ok: false, error: 'Booking not found.' }
  }

  // Only allow cancellation from pre-Scheduled statuses
  const cancellableStatuses = ['Pending Payment', 'Submitted', 'Confirmed']
  if (!cancellableStatuses.includes(booking.status)) {
    return {
      ok: false,
      error: `Cannot cancel a booking with status "${booking.status}".`,
    }
  }

  // Check cutoff: 3:30pm AWST the day prior to collection
  const items = booking.booking_item as Array<{
    unit_price_cents: number
    no_services: number
    is_extra: boolean
    collection_date: { date: string }
  }>
  if (items.length > 0) {
    const collectionDateStr = items[0]?.collection_date?.date
    if (collectionDateStr && isPastCancellationCutoff(collectionDateStr, new Date())) {
      return {
        ok: false,
        error:
          'Cancellation cutoff has passed (3:30pm the day before collection).',
      }
    }
  }

  // Perform the cancellation. `.select()` returns the affected rows so a silent
  // RLS no-op (0 rows changed, no error) surfaces as an explicit error instead
  // of a false success — see assertRowsAffected / F5 (VER-247).
  const { data: cancelled, error: updateError } = await supabase
    .from('booking')
    .update({
      status: 'Cancelled',
      cancelled_at: new Date().toISOString(),
    })
    .eq('id', bookingId)
    .select('id')

  const guard = assertRowsAffected(
    cancelled,
    updateError,
    'Unable to cancel this booking. It may no longer be cancellable, or you may not have permission.',
  )
  if (!guard.ok) return guard

  // If booking has paid extras, create a pending refund_request for admin review
  const paidItems = items.filter((i) => i.is_extra && i.unit_price_cents > 0)
  const refundAmountCents = paidItems.reduce(
    (sum, i) => sum + i.unit_price_cents * i.no_services,
    0
  )

  if (refundAmountCents > 0 && booking.contact_id && booking.client_id) {
    const { error: refundInsertError } = await supabase
      .from('refund_request')
      .insert({
        booking_id: booking.id,
        contact_id: booking.contact_id,
        client_id: booking.client_id,
        amount_cents: refundAmountCents,
        reason: REFUND_REASONS.residentCancellation,
        status: 'Pending',
      })

    if (refundInsertError) {
      console.error(
        'Failed to create refund_request for resident-cancelled booking:',
        refundInsertError.message
      )
    }
  }

  // Fire booking_cancelled notification — fire-and-forget
  await invokeSendNotification(supabase, {
    type: 'booking_cancelled',
    booking_id: bookingId,
    refund_status: refundAmountCents > 0 ? 'pending_review' : undefined,
  })

  return { ok: true, data: undefined }
}

/**
 * Dispute an NCN. Resident can only dispute notices in 'Issued' status
 * on their own bookings. RLS policy enforces ownership + status transition.
 */
export async function disputeNcn(ncnId: string): Promise<Result<void>> {
  if (!ncnId) return { ok: false, error: 'NCN ID is required.' }

  const supabase = await createClient()

  // RLS policy ncn_resident_update_dispute enforces: status must be 'Issued' + own booking
  const { data: disputed, error } = await supabase
    .from('non_conformance_notice')
    .update({ status: 'Disputed' })
    .eq('id', ncnId)
    .select('id')

  const guard = assertRowsAffected(
    disputed,
    error,
    'Unable to dispute this notice. It may already be under review or no longer disputable.',
  )
  if (!guard.ok) return guard
  return { ok: true, data: undefined }
}

/**
 * Dispute a Nothing Presented notice. Same pattern as NCN dispute.
 */
export async function disputeNp(npId: string): Promise<Result<void>> {
  if (!npId) return { ok: false, error: 'NP ID is required.' }

  const supabase = await createClient()

  const { data: disputed, error } = await supabase
    .from('nothing_presented')
    .update({ status: 'Disputed' })
    .eq('id', npId)
    .select('id')

  const guard = assertRowsAffected(
    disputed,
    error,
    'Unable to dispute this notice. It may already be under review or no longer disputable.',
  )
  if (!guard.ok) return guard
  return { ok: true, data: undefined }
}