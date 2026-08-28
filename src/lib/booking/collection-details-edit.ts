import type { Database } from '@/lib/supabase/types'
import { isContractorStaff } from '@/lib/auth/roles'

type BookingStatus = Database['public']['Enums']['booking_status']
type AppRole = Database['public']['Enums']['app_role']

// Pre-dispatch statuses whose collection details (location / date / notes) any
// admin or staff role may edit from the booking-detail panel.
const PRE_DISPATCH_EDITABLE: BookingStatus[] = [
  'Pending Payment',
  'Submitted',
  'Confirmed',
]

// Admin/staff roles allowed to edit a pre-dispatch booking.
const ADMIN_ROLES: AppRole[] = [
  'contractor-admin',
  'contractor-staff',
  'client-admin',
  'client-staff',
]

// Post-dispatch statuses that a contractor (D&M) role may still edit, to correct
// a crew collection error after dispatch/closeout. Scheduled = VER-285;
// Completed = #378 (a "previous booking" collected on the wrong day). Client-tier
// roles are deliberately excluded. The exception/rebook states (Non-conformance,
// Nothing Presented, Rebooked, Missed Collection) keep their dedicated NCN/NP
// rebook flow and are NOT editable here.
const CONTRACTOR_POST_DISPATCH_EDITABLE: BookingStatus[] = ['Scheduled', 'Completed']

/**
 * Whether the given role may edit a booking's collection details from the
 * admin booking-detail panel, given the booking's current status.
 *
 * - Pre-dispatch (Pending Payment / Submitted / Confirmed): any admin/staff
 *   role (contractor-admin/-staff, client-admin/-staff).
 * - Post-dispatch (Scheduled / Completed): contractor roles only (D&M staff).
 *   Once a booking is Scheduled (auto at 3:25pm AWST the day prior) the standard
 *   edit affordance is gone, but crews sometimes need the collection date
 *   corrected after dispatch (VER-285) or after a wrong-day collection has been
 *   closed out as Completed (#378). Client-tier roles are deliberately excluded.
 * - Any other status (Cancelled, exception/rebook states): not editable here.
 *
 * Used by both the client panel (to show the edit affordance) and the
 * updateCollectionDetails server action (to authorise the write), so the two
 * guards can never drift.
 */
export function canEditCollectionDetails(
  status: BookingStatus,
  role: AppRole | null,
): boolean {
  if (role == null) return false
  if (PRE_DISPATCH_EDITABLE.includes(status)) return ADMIN_ROLES.includes(role)
  if (CONTRACTOR_POST_DISPATCH_EDITABLE.includes(status)) return isContractorStaff(role)
  return false
}

/**
 * Whether `role` may edit an Illegal Dumping booking's ID-specific fields
 * (`geo_address`/pin, `id_waste_types`, `id_volume`, evidence `photos`) from
 * the admin booking-detail panel.
 *
 * Contractor-tier ONLY, at every status `canEditCollectionDetails` allows —
 * client-tier admins keep Location/Date/Notes editing pre-dispatch but the ID
 * fields stay read-only for them: a council views the illegal-dumping record,
 * it never restates what was dumped or where (design decision 28/08/2026,
 * docs/superpowers/specs/2026-08-28-id-booking-edit-design.md). Completed
 * bookings remain editable without a time bound (UC1 — reaffirmed by Dan);
 * terminal/exception statuses (Cancelled, NCN, NP, Rebooked) are excluded —
 * those records own their lifecycle via the rebook flow.
 *
 * Shared by the edit UI, the updateIdDetails server action, and mirrored by
 * the enforce_booking_id_fields_write DB trigger, so the layers can't drift.
 */
export function canEditIdDetails(
  status: BookingStatus,
  role: AppRole | null,
): boolean {
  return isContractorStaff(role) && canEditCollectionDetails(status, role)
}

/** Minimal target-date shape needed by the reschedule date-dimension gate. */
export interface RescheduleTargetDate {
  /** `collection_date.is_open`. A closed date is `false`. */
  is_open: boolean
  /** `collection_date.date` as an ISO `yyyy-mm-dd` string. */
  date: string
}

/**
 * D1 (#378) — whether `role` may move a booking ONTO `target`, layered on top of
 * the status/role gate (canEditCollectionDetails).
 *
 * The date dimension is orthogonal to the booking's status: only contractor-tier
 * (D&M) staff may reschedule into a CLOSED (`is_open = false`, an admin/holiday
 * closure — BR-0025) or PAST (`date < today`, an earlier/back-dated) collection
 * date. An open, today-or-future target imposes no extra privilege — any admin
 * role that already passed canEditCollectionDetails may pick it.
 *
 * `today` (ISO `yyyy-mm-dd`) is caller-injected so the decision is pure and
 * deterministic. Pass the SAME today the admin date-picker filters on so the
 * server never rejects a date the client-tier dropdown legitimately offered.
 * String comparison is chronological for zero-padded ISO dates.
 *
 * Capacity note: this is a gate on WHO may move the booking, not a capacity
 * check — see capacityBlocksMove() for the capacity dimension (#426, 22/08/2026:
 * client-tier gated, contractor keeps the override). The
 * recalculate_collection_date_units() trigger re-sums both the old and new dates
 * on the move, so no slot is double-counted or wrongly freed.
 */
export function canRescheduleToTargetDate(
  role: AppRole | null,
  target: RescheduleTargetDate,
  today: string,
): boolean {
  const isClosedOrPast = target.is_open === false || target.date < today
  if (!isClosedOrPast) return true
  return isContractorStaff(role)
}

/** Units a booking holds per capacity bucket (category.code). */
export interface CategoryUnits {
  bulk: number
  anc: number
  id: number
}

/** Sum a booking's items into per-bucket units; unknown codes are ignored. */
export function unitsByCategory(
  items: ReadonlyArray<{ no_services: number; category_code: string | null | undefined }>,
): CategoryUnits {
  const out: CategoryUnits = { bulk: 0, anc: 0, id: 0 }
  for (const it of items) {
    if (it.category_code === 'bulk' || it.category_code === 'anc' || it.category_code === 'id') {
      out[it.category_code] += it.no_services
    }
  }
  return out
}

/**
 * Capacity dimension of a date move (#426, 22/08/2026). Contractor-tier keeps
 * the documented override — a D&M date correction is never capacity-gated.
 * Client-tier may only move a booking onto a date with room for EVERY bucket
 * the booking uses (units ≤ remaining in that bucket). `remaining` is the
 * target's `limit − booked` per bucket (pool-aware: callers resolve the
 * collection_date_pool row for pooled areas). Moving onto the booking's
 * current date is a no-op upstream and never reaches here.
 */
export function capacityBlocksMove(
  role: AppRole | null,
  units: CategoryUnits,
  remaining: CategoryUnits,
): boolean {
  if (isContractorStaff(role)) return false
  return (
    (units.bulk > 0 && units.bulk > remaining.bulk) ||
    (units.anc > 0 && units.anc > remaining.anc) ||
    (units.id > 0 && units.id > remaining.id)
  )
}

/** `limit − booked` per bucket from any row carrying the capacity counters (date or pool). */
export function remainingByCategory(cap: {
  bulk_capacity_limit: number
  bulk_units_booked: number
  anc_capacity_limit: number
  anc_units_booked: number
  id_capacity_limit: number
  id_units_booked: number
}): CategoryUnits {
  return {
    bulk: cap.bulk_capacity_limit - cap.bulk_units_booked,
    anc: cap.anc_capacity_limit - cap.anc_units_booked,
    id: cap.id_capacity_limit - cap.id_units_booked,
  }
}
