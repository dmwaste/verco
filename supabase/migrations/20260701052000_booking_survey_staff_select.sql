-- ============================================================================
-- VER-179 SLA dashboard §3.10 / §4.3 — RS insight card (Resident Satisfaction)
-- ============================================================================
-- booking_survey had ONLY a resident SELECT + a field INSERT policy, so a
-- client-admin reading through the anon key got zero rows and Resident Satisfaction
-- could never populate. Add a staff SELECT policy.
--
-- Mirrors service_ticket_staff_select (NOT ncn_staff_select): client-tier staff +
-- contractor-admin/staff only. Deliberately EXCLUDES field/ranger — surveys are not
-- a field-crew concern and those are zero-PII roles. Tenant-scoped via
-- accessible_client_ids() and narrowed by sub-client (VER-216); the helper returns
-- true for whole-client users, so this is safe for the default whole-client scope
-- and correctly narrows a COT-only client-admin. booking_survey.booking_id is
-- NOT NULL, so the helper is always called with a real id.
-- ============================================================================

CREATE POLICY booking_survey_staff_select ON public.booking_survey
  FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (
      is_client_staff()
      OR current_user_role() = ANY (ARRAY['contractor-admin'::app_role, 'contractor-staff'::app_role])
    )
    AND user_sub_client_allows_booking(booking_id)
  );
