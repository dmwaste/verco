-- VER-304 — Allow contractor-staff to write allocation overrides.
--
-- VER-220 (20260520030000) restricted INSERT/UPDATE to contractor-admin +
-- client-admin. Per the role model, contractor-staff is "all clients — limited
-- write", and the allocation-adjustment UI is now exposed to the whole
-- contractor tier plus client-admin (NOT client-staff). Widen the two write
-- policies to match so contractor-staff's Adjust Allocation button is not
-- RLS-denied on submit.
--
-- SELECT (already includes contractor-staff + client-staff) and DELETE
-- (admin-only; the feature reduces via UPDATE, never DELETE) are unchanged.
-- Tenant scoping for the client tier is preserved via
-- current_user_client_allows_property(); the contractor tier is cross-tenant
-- by design (it already SELECTs all tenants).

DROP POLICY IF EXISTS allocation_override_insert ON public.allocation_override;
CREATE POLICY allocation_override_insert ON public.allocation_override
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND (
      current_user_role() IN ('contractor-admin'::app_role, 'contractor-staff'::app_role)
      OR (
        current_user_role() = 'client-admin'::app_role
        AND current_user_client_allows_property(property_id)
      )
    )
  );

DROP POLICY IF EXISTS allocation_override_update ON public.allocation_override;
CREATE POLICY allocation_override_update ON public.allocation_override
  FOR UPDATE TO authenticated
  USING (
    current_user_role() IN ('contractor-admin'::app_role, 'contractor-staff'::app_role)
    OR (
      current_user_role() = 'client-admin'::app_role
      AND current_user_client_allows_property(property_id)
    )
  )
  WITH CHECK (
    current_user_role() IN ('contractor-admin'::app_role, 'contractor-staff'::app_role)
    OR (
      current_user_role() = 'client-admin'::app_role
      AND current_user_client_allows_property(property_id)
    )
  );
