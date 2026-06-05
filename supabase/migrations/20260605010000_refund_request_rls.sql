-- refund_request had RLS ENABLED but ZERO policies (deny-all) since the initial
-- schema, so the admin refunds queue was empty for EVERY role (including
-- contractor-admin) — the queue was effectively dead. Add tenant-scoped staff
-- SELECT + UPDATE, mirroring the NCN/NP pattern. No field role: refunds carry
-- dollar amounts + the resident contact, which field/ranger must never see.

DROP POLICY IF EXISTS refund_request_staff_select ON refund_request;
CREATE POLICY refund_request_staff_select ON refund_request FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (is_client_staff() OR is_contractor_user())
    AND user_sub_client_allows_booking(booking_id)
  );

-- Decline is a direct client UPDATE (status -> Declined); approve goes via the
-- process-refund Edge Function (service role). This gates the direct path.
DROP POLICY IF EXISTS refund_request_staff_update ON refund_request;
CREATE POLICY refund_request_staff_update ON refund_request FOR UPDATE
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND user_sub_client_allows_booking(booking_id)
  );
