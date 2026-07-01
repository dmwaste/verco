import type { Database } from '@/lib/supabase/types'

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

// Contractor (D&M) roles — the only roles permitted to reschedule an
// already-dispatched (Scheduled) booking.
const CONTRACTOR_ROLES: AppRole[] = ['contractor-admin', 'contractor-staff']

/**
 * Whether the given role may edit a booking's collection details from the
 * admin booking-detail panel, given the booking's current status.
 *
 * - Pre-dispatch (Pending Payment / Submitted / Confirmed): any admin/staff
 *   role (contractor-admin/-staff, client-admin/-staff).
 * - Scheduled: contractor roles only (D&M staff). Once a booking is Scheduled
 *   (auto at 3:25pm AWST the day prior) the standard edit affordance is gone,
 *   but crews sometimes need the collection date corrected after dispatch —
 *   VER-285. Client-tier roles are deliberately excluded.
 * - Any other status (Cancelled, Completed, exception/rebook states): not
 *   editable here.
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
  if (status === 'Scheduled') return CONTRACTOR_ROLES.includes(role)
  return false
}
