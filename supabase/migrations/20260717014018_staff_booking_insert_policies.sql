-- Staff INSERT policies for booking + booking_item — unblocks NCN/NP rebooks.
--
-- The NCN/NP rebook server actions (admin non-conformance / nothing-presented
-- detail pages) clone the source booking with a direct
-- `supabase.from('booking').insert(...)` under the staff user's JWT. The only
-- INSERT policy on booking is booking_resident_insert (resident/strata), and
-- booking_item has NO insert policy at all — so every staff rebook ever
-- attempted failed with 42501 "new row violates row-level security policy for
-- table booking". Prod evidence (2026-07-17): zero bookings with rebook notes,
-- zero NPs in 'Rebooked', zero NCNs in 'Rescheduled' — the feature has been
-- dead since it shipped. Same class as the refund_request INSERT gap
-- (20260711080000): RLS coverage lagging data plumbing.
--
-- Staff booking creation elsewhere goes through SECURITY DEFINER RPCs
-- (create_mud_booking, create_id_booking_with_capacity_check) that self-gate;
-- the rebook path is a low-volume staff-mediated direct write, so it gets a
-- proper policy instead. Gates mirror the staff write posture:
--   • all four staff tiers (matches verifyStaffRole, the action's gate)
--   • tenant scope via accessible_client_ids()
--   • sub-client narrowing via user_sub_client_allows_area() (VER-216)
--   • staged go-live gate via collection_area_is_active() (WS-A) — staff
--     rebooks stop when a council is toggled off, like every other write path
-- field/ranger are excluded (not in the role array); anon / role-less callers
-- fail closed (current_user_role() IS NULL → `= ANY` is not true).
--
-- Capacity note: this path doesn't take the capacity advisory lock (Red Line
-- #4 gates the resident/self-serve flows); the recalc trigger on booking_item
-- still keeps units_booked counters correct. Rebooks are remedies for failed
-- collections — over-capacity staff adds are tracked in #426.

CREATE POLICY booking_staff_insert ON booking FOR INSERT
  WITH CHECK (
    current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND client_id IN (SELECT accessible_client_ids())
    AND user_sub_client_allows_area(collection_area_id)
    AND collection_area_is_active(collection_area_id)
  );

-- The parent-booking EXISTS runs under the caller's booking SELECT RLS, which
-- already scopes staff by accessible_client_ids() + sub-client — so an item
-- can only attach to a booking the caller can read (mirrors
-- booking_item_staff_update, 20260515055645).
CREATE POLICY booking_item_staff_insert ON booking_item FOR INSERT
  TO authenticated
  WITH CHECK (
    current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND EXISTS (SELECT 1 FROM booking WHERE booking.id = booking_item.booking_id)
  );
