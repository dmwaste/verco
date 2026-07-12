'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { invokeSendNotification } from '@/lib/notifications/invoke'
import { isPastCancellationCutoff } from '@/lib/booking/cancellation-cutoff'
import {
  canEditCollectionDetails,
  canRescheduleToTargetDate,
} from '@/lib/booking/collection-details-edit'
import { STAFF_ROLES } from '@/lib/auth/roles'
import { orchestrateRefund, type RefundOrchestrationState } from '@/lib/payments/orchestrate-refund'
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
  if (!role || !(STAFF_ROLES as readonly string[]).includes(role)) {
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
  if (!role || !(STAFF_ROLES as readonly string[]).includes(role)) {
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
  if (!role || !(STAFF_ROLES as readonly string[]).includes(role)) {
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

  // Raise + fire the refund via the shared orchestrator (booking already
  // cancelled — failures are logged and reflected in the returned state).
  const { state: refundState } = await orchestrateRefund(supabase, {
    bookingId: booking.id,
    contactId: booking.contact_id,
    clientId: booking.client_id,
    amountCents: refundAmountCents,
    reason: 'Booking cancelled by staff',
  })

  // Fire booking_cancelled notification. Fire-and-forget — failure never
  // reverts the cancel. Uses direct fetch() per CLAUDE.md §11 (supabase
  // .functions.invoke is unreliable in SSR). refund_status mirrors
  // updateBookingQuantities' mapping: only claim "processed" when
  // process-refund actually accepted it — a -staff cancel legitimately lands
  // 'queued' (awaiting admin approval on the Refunds page), and
  // 'failed'/'none' must not show a refund line at all.
  const refundStatus =
    refundState === 'initiated' ? ('processed' as const)
    : refundState === 'queued' ? ('pending_review' as const)
    : undefined
  await invokeSendNotification(supabase, {
    type: 'booking_cancelled',
    booking_id: bookingId,
    ...(refundStatus ? { refund_status: refundStatus } : {}),
  })

  return { ok: true, data: undefined }
}

export async function updateContact(
  contactId: string,
  data: { first_name: string; last_name: string; email: string; mobile_e164: string | null },
): Promise<Result<void>> {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (!role || !(STAFF_ROLES as readonly string[]).includes(role)) {
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
  if (!role || !(STAFF_ROLES as readonly string[]).includes(role)) {
    return { ok: false, error: 'Insufficient permissions.' }
  }

  // Fetch current state to compare — skip no-op updates so the audit log
  // doesn't accrue "0 fields updated" entries when the user clicks Save
  // without changing anything.
  const { data: current } = await supabase
    .from('booking')
    .select('status, location, collection_area_id, booking_item(id, collection_date_id)')
    .eq('id', bookingId)
    .single()

  if (!current) return { ok: false, error: 'Booking not found.' }

  // Status gate (VER-285). Standard editing is allowed pre-dispatch; once a
  // booking is Scheduled only contractor roles (D&M staff) may reschedule it,
  // to correct a dispatched booking's collection date. Client-tier roles
  // cannot edit a Scheduled booking; any other status is not editable here.
  // Shared with the client panel's edit affordance so the two can't drift.
  if (!canEditCollectionDetails(current.status, role)) {
    return {
      ok: false,
      error: `Cannot edit collection details for a booking with status "${current.status}".`,
    }
  }

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
    // Server-side re-validation of the target date (D1, #378). The admin
    // date-picker relaxes its is_open/date filter for contractor-tier staff, but
    // booking_item_staff_update RLS permits ALL admin roles to write — so the
    // "only D&M staff may back-date or move into a closed date" rule must be
    // re-enforced here, independent of the dropdown. This fetch only reads
    // is_open/date for the gate below; it is NOT the tenant boundary
    // (collection_date is public-readable for open dates) — the write's tenant
    // scope comes from the booking / booking_item RLS policies.
    const { data: targetDate, error: targetError } = await supabase
      .from('collection_date')
      .select('id, date, is_open, collection_area_id')
      .eq('id', data.collection_date_id!)
      .single()

    if (targetError || !targetDate) {
      return { ok: false, error: 'Target collection date not found.' }
    }

    // collection_date is public-SELECT, so the id alone proves nothing about
    // tenancy — pin the target to the booking's own area or a crafted request
    // could move items onto (and mutate the capacity counters of) another
    // area's or another tenant's date. booking_item RLS scopes the parent
    // booking, not the new collection_date_id it points at.
    if (targetDate.collection_area_id !== current.collection_area_id) {
      return { ok: false, error: "Target collection date is outside this booking's collection area." }
    }

    // Same UTC "today" the admin date-picker filters on, so the server never
    // rejects a date the client-tier dropdown legitimately offered.
    const today = new Date().toISOString().split('T')[0]!
    if (!canRescheduleToTargetDate(role, { is_open: targetDate.is_open, date: targetDate.date }, today)) {
      return {
        ok: false,
        error: 'Only D&M staff can reschedule a booking into a closed or past collection date.',
      }
    }

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
    // Deliberately does NOT touch collection_stop (#390.2, D2 doc-guard). On a
    // #378 post-dispatch correction the stop stays as-dispatched — it's an
    // immutable record of what the crew was routed to do, and the contractual
    // on-time KPI keys off it (see on-time.ts). Repointing the stop here would
    // let a back-date launder a wrong-day miss. booking_item carries the
    // corrected intent; the stop carries the dispatched history.
  }

  // Notify the resident their booking changed (#388) — Confirmed only. A #378
  // post-dispatch date correction (Scheduled/Completed) is DELIBERATELY excluded:
  // the collection has been dispatched or already happened, so a "your booking
  // date is now <past date>" email would only confuse. Reached only when
  // something actually changed (the no-op case returns earlier). Fire-and-forget.
  if (current.status === 'Confirmed') {
    await invokeSendNotification(supabase, {
      type: 'booking_updated',
      booking_id: bookingId,
      edit_ref: new Date().toISOString(),
    })
  }

  return { ok: true, data: undefined }
}

export async function updateNotes(
  bookingId: string,
  notes: string,
): Promise<Result<void>> {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (!role || !(STAFF_ROLES as readonly string[]).includes(role)) {
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

/**
 * Inline quantity editor (issue #380 / BR-0028): change a booking's per-service
 * quantities while KEEPING the same collection date.
 *
 * Reuses the existing in-place engine — the `create-booking` EF with `replaces`
 * + `inline_edit` → `update_booking_items_in_place` RPC — which re-prices, applies
 * the delta+drift money model, re-checks capacity under an advisory lock, and
 * writes the audit diff. This action:
 *   1. builds the EF envelope from the booking (current date/location/swap),
 *   2. calls the EF (which returns `refund_owed_cents` for a reduction), then
 *   3. orchestrates the refund via the existing refund_request + process-refund
 *      machinery — identical to cancelBooking (the EF runs as service-role and
 *      cannot call process-refund, which authorises on the caller's role).
 *
 * The EF blocks price-increases (→ PR-B) and price-drift with a 409; this action
 * surfaces that error. MUD + Pending Payment are excluded here (double-spend /
 * open-session desync). Role/status gate = canEditCollectionDetails (shared with
 * the rest of the inline editor + the EF's own guard).
 */
const updateQuantitiesInput = z.object({
  bookingId: z.string().uuid(),
  // no_services 0 = remove that service line (the EF's smart-diff drops it);
  // the ≥1-remaining guard below still forces at least one kept service.
  items: z
    .array(z.object({ service_id: z.string().uuid(), no_services: z.number().int().min(0).max(10) }))
    .min(1)
    .max(20),
})

/** How the refund half of a quantity reduction ended up (see orchestrateRefund). */
export type QuantityEditRefundState = RefundOrchestrationState

export async function updateBookingQuantities(
  bookingId: string,
  items: Array<{ service_id: string; no_services: number }>,
): Promise<Result<{ refundOwedCents: number; refundState: QuantityEditRefundState }>> {
  const parsed = updateQuantitiesInput.safeParse({ bookingId, items })
  if (!parsed.success) {
    return { ok: false, error: 'Invalid quantity edit input.' }
  }

  const cleanItems = parsed.data.items.filter((i) => i.no_services > 0)
  if (cleanItems.length === 0) {
    return { ok: false, error: 'A booking must keep at least one service. Use Cancel to remove all services.' }
  }

  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (!role || !(STAFF_ROLES as readonly string[]).includes(role)) {
    return { ok: false, error: 'Insufficient permissions.' }
  }

  const { data: booking, error: fetchError } = await supabase
    .from('booking')
    .select(
      'id, status, type, location, property_id, collection_area_id, contact_id, client_id, booking_item(collection_date_id)',
    )
    .eq('id', bookingId)
    .single()

  if (fetchError || !booking) {
    return { ok: false, error: 'Booking not found.' }
  }

  // Same status/role gate as the rest of the inline editor + the EF guard.
  if (!canEditCollectionDetails(booking.status, role)) {
    return {
      ok: false,
      error: `Cannot edit quantities for a booking with status "${booking.status}".`,
    }
  }

  // MUD excluded (double-spend against the per-FY MUD cap). Pending Payment
  // excluded (open Stripe-session desync — out of scope for PR-A; see spec §11 #2).
  if (booking.type === 'MUD') {
    return { ok: false, error: 'Editing services is not supported for MUD bookings. Cancel and rebook.' }
  }
  if (booking.status === 'Pending Payment') {
    return { ok: false, error: 'Resolve the pending payment first. Cancel and rebook to change this booking.' }
  }
  // Quantity edits are Confirmed-only — canEditCollectionDetails is wider
  // (Scheduled/Completed for contractor tier, the #378 date-correction path).
  // A Scheduled/Completed reduction would refund a dispatched or already-
  // collected service and desync its collection_stop rows. Matches the UI's
  // canEditQuantities gate; this action is the boundary, not the UI.
  if (booking.status !== 'Confirmed') {
    return {
      ok: false,
      error: `Cannot edit quantities for a booking with status "${booking.status}". Cancel and rebook.`,
    }
  }

  const items0 = (booking.booking_item ?? []) as Array<{ collection_date_id: string }>
  const collectionDateId = items0[0]?.collection_date_id
  if (!collectionDateId) return { ok: false, error: 'Booking has no collection date.' }
  if (!booking.property_id || !booking.collection_area_id) {
    return { ok: false, error: 'Booking is missing its property or collection area.' }
  }
  // A quantity edit must not alter location — never fabricate one for the EF's
  // required field. A blank location is a data-repair case, not an edit case.
  if (!booking.location) {
    return { ok: false, error: 'Booking has no location set — fix the booking location first.' }
  }

  // Re-send the booking's current allocation swap so the EF doesn't strip it and
  // misprice (spec §11 #7). The editor never changes the swap. Fail loud on a
  // read error — silently omitting `swap` would make the EF DELETE the swap row
  // and re-price without the conversion.
  const { data: swapRow, error: swapError } = await supabase
    .from('allocation_swap')
    .select('id')
    .eq('booking_id', bookingId)
    .maybeSingle()
  if (swapError) {
    return { ok: false, error: `Could not read the booking's allocation swap: ${swapError.message}` }
  }

  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return { ok: false, error: 'Not authenticated.' }

  // Direct fetch with the user's session JWT (CLAUDE.md §11 — invoke is
  // unreliable in SSR). Contact is omitted: the edit branch never uses it.
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/create-booking`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      property_id: booking.property_id,
      collection_area_id: booking.collection_area_id,
      collection_date_id: collectionDateId,
      // Pass the current location so the RPC's IS-DISTINCT guard leaves it
      // unchanged (a quantity edit must not alter location/notes; blank
      // location is rejected above).
      location: booking.location,
      items: cleanItems,
      replaces: bookingId,
      inline_edit: true,
      ...(swapRow ? { swap: true } : {}),
    }),
  })

  if (!res.ok) {
    const errorBody = await res.text()
    try {
      const parsed = JSON.parse(errorBody)
      return { ok: false, error: parsed.error ?? `Update failed (${res.status})` }
    } catch {
      return { ok: false, error: `Update failed (${res.status})` }
    }
  }

  const result = (await res.json()) as { refund_owed_cents?: number }
  const refundOwedCents = result.refund_owed_cents ?? 0

  // Orchestrate the refund via the shared helper (mirrors cancelBooking). The
  // booking is already reduced by this point, so refund failures are SURFACED
  // in refundState, never swallowed — 'failed' means no Pending row exists, and
  // '-staff' reductions land 'queued' (process-refund is approval-tier only).
  const { state: refundState, refundRequestId } = await orchestrateRefund(supabase, {
    bookingId,
    contactId: booking.contact_id,
    clientId: booking.client_id,
    amountCents: refundOwedCents,
    reason: 'Booking quantity reduced by staff',
  })

  // Notify the resident their (Confirmed) booking changed — a current-state
  // snapshot + a refund line so money moving back is explained (#388). Only
  // surface a refund when one actually went through: 'initiated' → processed,
  // 'queued' → pending review; 'failed'/'none' show no refund line. edit_ref
  // makes the idempotency key unique per edit. We pass the refund_request_id
  // (not the amount) — send-notification derives the DISPLAYED cents from that
  // row so the figure can't be forged. Fire-and-forget.
  const refundStatus =
    refundState === 'initiated' ? ('processed' as const)
    : refundState === 'queued' ? ('pending_review' as const)
    : undefined
  await invokeSendNotification(supabase, {
    type: 'booking_updated',
    booking_id: bookingId,
    edit_ref: new Date().toISOString(),
    ...(refundStatus && refundRequestId
      ? { refund_status: refundStatus, refund_request_id: refundRequestId }
      : {}),
  })

  return { ok: true, data: { refundOwedCents, refundState } }
}
