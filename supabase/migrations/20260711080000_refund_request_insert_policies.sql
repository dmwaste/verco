-- refund_request gained SELECT + UPDATE policies in 20260605010000 but never an
-- INSERT policy, so with RLS enabled every user-scoped insert was silently
-- denied — prod has ZERO refund_request rows ever. Five app paths insert here:
-- staff cancel (admin bookings), NCN + NP refund actions, the #380 inline
-- quantity editor, and resident self-cancel. All were landing in swallowed
-- console.error branches (pre-release review, 2026-07-11).
--
-- Two policies, both Pending-only (nobody may insert a pre-Approved request)
-- and both pinning client_id/contact_id to the booking's own values via an
-- invoker-RLS EXISTS on booking — a caller can only reference a booking they
-- can already read, and cannot tag it with another tenant's client_id.

-- Staff tiers: tenant-scoped via accessible_client_ids + sub-client narrowing,
-- mirroring refund_request_staff_update's role set. No field/ranger (refunds
-- carry dollar amounts + the resident contact).
DROP POLICY IF EXISTS refund_request_staff_insert ON refund_request;
CREATE POLICY refund_request_staff_insert ON refund_request FOR INSERT
  WITH CHECK (
    status = 'Pending'
    AND client_id IN (SELECT accessible_client_ids())
    AND current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND user_sub_client_allows_booking(booking_id)
    AND EXISTS (
      SELECT 1 FROM booking b
      WHERE b.id = refund_request.booking_id
        AND b.client_id = refund_request.client_id
    )
  );

-- Residents/strata: own bookings only. The EXISTS runs under the caller's
-- booking SELECT RLS, which already scopes residents to their own bookings;
-- the contact_id equality stops a resident minting a request against someone
-- else's contact on a booking they can read (e.g. strata-shared).
DROP POLICY IF EXISTS refund_request_resident_insert ON refund_request;
CREATE POLICY refund_request_resident_insert ON refund_request FOR INSERT
  WITH CHECK (
    status = 'Pending'
    AND current_user_role() = ANY (ARRAY['resident'::app_role, 'strata'::app_role])
    AND EXISTS (
      SELECT 1 FROM booking b
      WHERE b.id = refund_request.booking_id
        AND b.client_id = refund_request.client_id
        AND b.contact_id = refund_request.contact_id
    )
  );
