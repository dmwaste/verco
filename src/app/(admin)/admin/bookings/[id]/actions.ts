'use server'

import { createClient } from '@/lib/supabase/server'
import { invokeSendNotification } from '@/lib/notifications/invoke'
import { isPastCancellationCutoff } from '@/lib/booking/cancellation-cutoff'
import type { Result } from '@/lib/result'

/**
 * Cancel a booking that's being replaced via the admin "Edit services" flow.
 *
 * The admin booking-detail's "Edit services" link routes staff through the
 * /book/services wizard which submits to the `create-booking` EF — that EF
 * always creates a NEW booking. Without this cleanup, the wizard leaves
 * two bookings at the same address (one with the old services + ref, one
 * with the new services + a fresh ref).
 *
 * This server action is called by confirm-form.tsx after a successful new
 * booking is created (when the `replaces` query param is present). It
 * cancels the old booking with a clear reason linking to the replacement.
 *
 * Distinct from cancelBooking:
 * - No notification email (the resident isn't really losing a booking —
 *   they're getting a modified one; cancellation email would be confusing)
 * - No refund flow (replacement may or may not require money movement;
 *   staff handle that separately — surface as a follow-up)
 *
 * Audit log captures the change automatically via the audit_trigger.
 */
export async function replaceBookingAfterEdit(
  oldBookingId: string,
  newBookingRef: string,
): Promise<Result<void>> {
  if (!oldBookingId || !newBookingRef) {
    return { ok: false, error: 'Old booking ID and new ref are required.' }
  }

  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  const adminRoles = ['client-admin', 'client-staff', 'contractor-admin', 'contractor-staff']
  if (!role || !adminRoles.includes(role)) {
    return { ok: false, error: 'Insufficient permissions.' }
  }

  // State-machine trigger enforces valid transitions (Submitted/Confirmed →
  // Cancelled is allowed by staff). Chain .select() so any silent RLS gap
  // surfaces as an explicit error instead of a phantom success.
  const { data: updated, error } = await supabase
    .from('booking')
    .update({
      status: 'Cancelled',
      cancellation_reason: `Replaced by booking ${newBookingRef} (services edited)`,
      cancelled_at: new Date().toISOString(),
    })
    .eq('id', oldBookingId)
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  if (!updated) {
    return {
      ok: false,
      error: 'Old booking could not be cancelled (RLS or already in a terminal state).',
    }
  }
  return { ok: true, data: undefined }
}

export async function confirmBooking(bookingId: string): Promise<Result<void>> {
  if (!bookingId) {
    return { ok: false, error: 'Booking ID is required.' }
  }

  const supabase = await createClient()

  // Verify current user has admin/staff role
  const { data: role } = await supabase.rpc('current_user_role')
  const adminRoles = ['client-admin', 'client-staff', 'contractor-admin', 'contractor-staff']
  if (!role || !adminRoles.includes(role)) {
    return { ok: false, error: 'Insufficient permissions.' }
  }

  // Fetch booking to validate status transition
  const { data: booking, error: fetchError } = await supabase
    .from('booking')
    .select('id, status')
    .eq('id', bookingId)
    .single()

  if (fetchError || !booking) {
    return { ok: false, error: 'Booking not found.' }
  }

  if (booking.status !== 'Submitted') {
    return {
      ok: false,
      error: `Cannot confirm a booking with status "${booking.status}". Only Submitted bookings can be confirmed.`,
    }
  }

  const { error: updateError } = await supabase
    .from('booking')
    .update({ status: 'Confirmed' })
    .eq('id', bookingId)

  if (updateError) {
    return { ok: false, error: updateError.message }
  }

  return { ok: true, data: undefined }
}

export async function cancelBooking(bookingId: string): Promise<Result<void>> {
  if (!bookingId) {
    return { ok: false, error: 'Booking ID is required.' }
  }

  const supabase = await createClient()

  // Verify current user has admin/staff role
  const { data: role } = await supabase.rpc('current_user_role')
  const adminRoles = ['client-admin', 'client-staff', 'contractor-admin', 'contractor-staff']
  if (!role || !adminRoles.includes(role)) {
    return { ok: false, error: 'Insufficient permissions.' }
  }

  const { data: booking, error: fetchError } = await supabase
    .from('booking')
    .select('id, status, contact_id, client_id, booking_item(unit_price_cents, no_services, is_extra, collection_date!inner(date))')
    .eq('id', bookingId)
    .single()

  if (fetchError || !booking) {
    return { ok: false, error: 'Booking not found.' }
  }

  const cancellableStatuses = ['Pending Payment', 'Submitted', 'Confirmed']
  if (!cancellableStatuses.includes(booking.status)) {
    return {
      ok: false,
      error: `Cannot cancel a booking with status "${booking.status}".`,
    }
  }

  // Check cutoff: 3:30pm AWST the day prior to collection
  const items = booking.booking_item as Array<{ unit_price_cents: number; no_services: number; is_extra: boolean; collection_date: { date: string } }>
  if (items.length > 0) {
    const collectionDateStr = items[0]?.collection_date?.date
    if (collectionDateStr && isPastCancellationCutoff(collectionDateStr, new Date())) {
      return {
        ok: false,
        error: 'Cancellation cutoff has passed (3:30pm the day before collection).',
      }
    }
  }

  const { error: updateError } = await supabase
    .from('booking')
    .update({
      status: 'Cancelled',
      cancelled_at: new Date().toISOString(),
    })
    .eq('id', bookingId)

  if (updateError) {
    return { ok: false, error: updateError.message }
  }

  // If booking has paid items, create refund_request and trigger Stripe refund
  const paidItems = items.filter((i) => i.is_extra && i.unit_price_cents > 0)
  const refundAmountCents = paidItems.reduce((sum, i) => sum + i.unit_price_cents * i.no_services, 0)

  if (refundAmountCents > 0 && booking.contact_id && booking.client_id) {
    const { data: refundReq, error: refundInsertError } = await supabase
      .from('refund_request')
      .insert({
        booking_id: booking.id,
        contact_id: booking.contact_id,
        client_id: booking.client_id,
        amount_cents: refundAmountCents,
        reason: 'Booking cancelled by staff',
        status: 'Pending',
      })
      .select('id')
      .single()

    if (!refundInsertError && refundReq) {
      // Trigger refund via process-refund Edge Function.
      //
      // NOTE: duplicated by design across the 3 server-action refund sites:
      //   - admin/bookings/[id]/actions.ts          (this file)
      //   - admin/nothing-presented/[id]/actions.ts
      //   - admin/non-conformance/[id]/actions.ts
      // No shared `invokeEfWithSessionToken` server helper exists yet — the
      // 'use server' boundary makes the client-side helper ineligible. Three
      // sites with identical shape isn't worth an abstraction; if a 4th site
      // appears, extract then (rule-of-three trigger consciously deferred).
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
          console.error(`Refund trigger failed for cancelled booking ${booking.id}: ${errText}`)
          // Booking is already cancelled, refund_request in Pending — staff can retry from refunds page
        }
      }
    } else {
      console.error('Failed to create refund_request for cancelled booking:', refundInsertError?.message)
    }
  }

  // Fire booking_cancelled notification. Fire-and-forget — failure never
  // reverts the cancel. Uses direct fetch() per CLAUDE.md §11 (supabase
  // .functions.invoke is unreliable in SSR).
  await invokeSendNotification(supabase, {
    type: 'booking_cancelled',
    booking_id: bookingId,
    refund_status: refundAmountCents > 0 ? 'processed' : undefined,
  })

  return { ok: true, data: undefined }
}

export async function updateContact(
  contactId: string,
  data: { first_name: string; last_name: string; email: string; mobile_e164: string | null },
): Promise<Result<void>> {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  const adminRoles = ['client-admin', 'client-staff', 'contractor-admin', 'contractor-staff']
  if (!role || !adminRoles.includes(role)) {
    return { ok: false, error: 'Insufficient permissions.' }
  }

  if (!data.first_name.trim() || !data.last_name.trim() || !data.email.trim()) {
    return { ok: false, error: 'First name, last name, and email are required.' }
  }

  const newFirst = data.first_name.trim()
  const newLast = data.last_name.trim()
  const newEmail = data.email.trim().toLowerCase()
  const newMobile = data.mobile_e164?.trim() || null

  // Compare to current state — skip the UPDATE entirely if nothing changed.
  // Avoids producing "0 fields updated" audit-log noise when the user clicks
  // Save without altering any field.
  const { data: current } = await supabase
    .from('contacts')
    .select('first_name, last_name, email, mobile_e164')
    .eq('id', contactId)
    .single()

  if (
    current &&
    current.first_name === newFirst &&
    current.last_name === newLast &&
    current.email === newEmail &&
    current.mobile_e164 === newMobile
  ) {
    return { ok: true, data: undefined }
  }

  // full_name is a generated column — write first/last_name only.
  // Chain .select() so silent RLS rejection (zero rows affected) fails loud.
  const { data: updated, error } = await supabase
    .from('contacts')
    .update({
      first_name: newFirst,
      last_name: newLast,
      email: newEmail,
      mobile_e164: newMobile,
    })
    .eq('id', contactId)
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  if (!updated) {
    return { ok: false, error: 'Contact update was not applied (RLS or row missing).' }
  }
  return { ok: true, data: undefined }
}

export async function updateCollectionDetails(
  bookingId: string,
  data: { location: string; collection_date_id: string | null },
): Promise<Result<void>> {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  const adminRoles = ['client-admin', 'client-staff', 'contractor-admin', 'contractor-staff']
  if (!role || !adminRoles.includes(role)) {
    return { ok: false, error: 'Insufficient permissions.' }
  }

  // Fetch current state to compare — skip no-op updates so the audit log
  // doesn't accrue "0 fields updated" entries when the user clicks Save
  // without changing anything.
  const { data: current } = await supabase
    .from('booking')
    .select('location, booking_item(id, collection_date_id)')
    .eq('id', bookingId)
    .single()

  if (!current) return { ok: false, error: 'Booking not found.' }

  const items = (current.booking_item ?? []) as Array<{ id: string; collection_date_id: string }>
  const currentCdId = items[0]?.collection_date_id ?? null
  const locationChanged = current.location !== data.location
  const dateChanged =
    data.collection_date_id != null && data.collection_date_id !== currentCdId

  if (!locationChanged && !dateChanged) {
    return { ok: true, data: undefined }
  }

  if (locationChanged) {
    // Chain .select() so silent RLS rejection fails loud.
    const { data: bookingUpdated, error: bookingError } = await supabase
      .from('booking')
      .update({ location: data.location })
      .eq('id', bookingId)
      .select('id')
      .single()

    if (bookingError) return { ok: false, error: bookingError.message }
    if (!bookingUpdated) {
      return { ok: false, error: 'Booking update was not applied (RLS or row missing).' }
    }
  }

  if (dateChanged) {
    // Chain .select() so silent RLS rejection fails loud. Migration
    // 20260515055645_booking_item_rls_write_policies.sql added the UPDATE
    // policy that makes this actually take effect — before that, this call
    // would silently rejected with zero rows affected.
    const { data: itemsUpdated, error: itemError } = await supabase
      .from('booking_item')
      .update({ collection_date_id: data.collection_date_id ?? undefined })
      .eq('booking_id', bookingId)
      .select('id')

    if (itemError) return { ok: false, error: itemError.message }
    if (!itemsUpdated || itemsUpdated.length === 0) {
      return {
        ok: false,
        error: 'Collection date update was not applied (RLS or no booking items).',
      }
    }
  }

  return { ok: true, data: undefined }
}

export async function updateNotes(
  bookingId: string,
  notes: string,
): Promise<Result<void>> {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  const adminRoles = ['client-admin', 'client-staff', 'contractor-admin', 'contractor-staff']
  if (!role || !adminRoles.includes(role)) {
    return { ok: false, error: 'Insufficient permissions.' }
  }

  const newNotes = notes.trim() || null

  // Skip no-op updates — the booking-detail panel calls updateNotes alongside
  // updateCollectionDetails on every save, even when notes are unchanged.
  const { data: current } = await supabase
    .from('booking')
    .select('notes')
    .eq('id', bookingId)
    .single()

  if (current && current.notes === newNotes) {
    return { ok: true, data: undefined }
  }

  const { data: updated, error } = await supabase
    .from('booking')
    .update({ notes: newNotes })
    .eq('id', bookingId)
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  if (!updated) {
    return { ok: false, error: 'Notes update was not applied (RLS or row missing).' }
  }
  return { ok: true, data: undefined }
}
