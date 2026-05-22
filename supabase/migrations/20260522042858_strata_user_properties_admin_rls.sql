-- Adds admin-tier RLS policies on strata_user_properties so that:
--   (a) admin roles can SELECT rows when building the strata user edit form
--   (b) contractor-admin and client-admin can INSERT / DELETE assignments
--
-- The existing policy (strata_user_properties_select) already covers the strata
-- user viewing their own rows (user_id = auth.uid()). These policies are additive.

CREATE POLICY strata_user_properties_admin_select ON strata_user_properties
  FOR SELECT
  USING (
    has_role('contractor-admin') OR has_role('contractor-staff') OR
    has_role('client-admin') OR has_role('client-staff')
  );

CREATE POLICY strata_user_properties_admin_insert ON strata_user_properties
  FOR INSERT
  WITH CHECK (
    has_role('contractor-admin') OR has_role('client-admin')
  );

CREATE POLICY strata_user_properties_admin_delete ON strata_user_properties
  FOR DELETE
  USING (
    has_role('contractor-admin') OR has_role('client-admin')
  );
