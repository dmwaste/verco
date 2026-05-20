-- VER-220 — Tenant-scope allocation_override RLS
--
-- Closes a pre-existing gap surfaced during VER-216's sub-client work
-- (flagged in PR #79 body): allocation_override has no `client_id`
-- column and no tenant-scoping in its RLS policies. Until this
-- migration, a KWN client-admin could SELECT, INSERT, UPDATE and DELETE
-- overrides on properties belonging to any tenant (VV, WMRC, etc.).
--
-- ## Scoping path
--
-- allocation_override.property_id
--   → eligible_properties.collection_area_id
--     → collection_area.client_id
--
-- Per sub-client-scoping-pattern.md memory: "Don't write multi-hop
-- joins inline in policies — wrap in a SECURITY DEFINER function."
-- One helper, used by all four policies.
--
-- ## Out of scope
--
-- Sub-client narrowing is deliberately NOT added here. The same memory
-- note: "Don't add sub-client to this without fixing client-level
-- first." Sub-client narrowing for client-admin is a follow-up ticket
-- once this client-level fix lands.
--
-- Linear: VER-220

-- ----------------------------------------------------------------------
-- 1. Helper. Returns TRUE when the property belongs to a collection_area
--    whose client_id matches the current user's. Contractor-tier
--    short-circuit is intentionally NOT in the helper — keep tenant
--    allowance separate from role allowance so policies stay readable.
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_user_client_allows_property(p_property_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.eligible_properties ep
    JOIN public.collection_area ca ON ca.id = ep.collection_area_id
    WHERE ep.id = p_property_id
      AND ca.client_id = public.current_user_client_id()
  );
$$;

COMMENT ON FUNCTION public.current_user_client_allows_property(uuid) IS
  'VER-220. TRUE when the property belongs to a collection_area whose '
  'client_id matches the current user''s. Used by allocation_override '
  'policies. Contractor-tier roles bypass this via the policy''s OR.';

-- ----------------------------------------------------------------------
-- 2. Rewrite the four existing allocation_override policies. Drop + re-
--    create is cleaner than ALTER for review legibility.
-- ----------------------------------------------------------------------
DROP POLICY IF EXISTS allocation_override_select ON public.allocation_override;
DROP POLICY IF EXISTS allocation_override_insert ON public.allocation_override;
DROP POLICY IF EXISTS allocation_override_update ON public.allocation_override;
DROP POLICY IF EXISTS allocation_override_delete ON public.allocation_override;

-- SELECT: contractor-tier sees all; client-tier sees own tenant only.
CREATE POLICY allocation_override_select ON public.allocation_override
  FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('contractor-admin'::app_role, 'contractor-staff'::app_role)
    OR (
      current_user_role() IN ('client-admin'::app_role, 'client-staff'::app_role)
      AND current_user_client_allows_property(property_id)
    )
  );

-- INSERT: contractor-admin anywhere; client-admin only on own tenant.
-- created_by = auth.uid() preserved (audit trail).
CREATE POLICY allocation_override_insert ON public.allocation_override
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND (
      current_user_role() = 'contractor-admin'::app_role
      OR (
        current_user_role() = 'client-admin'::app_role
        AND current_user_client_allows_property(property_id)
      )
    )
  );

-- UPDATE: same gating in both USING (row must be visible to update)
-- and WITH CHECK (post-update row must remain visible).
CREATE POLICY allocation_override_update ON public.allocation_override
  FOR UPDATE TO authenticated
  USING (
    current_user_role() = 'contractor-admin'::app_role
    OR (
      current_user_role() = 'client-admin'::app_role
      AND current_user_client_allows_property(property_id)
    )
  )
  WITH CHECK (
    current_user_role() = 'contractor-admin'::app_role
    OR (
      current_user_role() = 'client-admin'::app_role
      AND current_user_client_allows_property(property_id)
    )
  );

-- DELETE: only admin tier, only own tenant.
CREATE POLICY allocation_override_delete ON public.allocation_override
  FOR DELETE TO authenticated
  USING (
    current_user_role() = 'contractor-admin'::app_role
    OR (
      current_user_role() = 'client-admin'::app_role
      AND current_user_client_allows_property(property_id)
    )
  );
