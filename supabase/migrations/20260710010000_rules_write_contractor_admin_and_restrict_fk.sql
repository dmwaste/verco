-- Allocation/service rules: contractor-admin-only writes + RESTRICT swap FKs.
--
-- 1. Write policies -> contractor-admin only (Dan, 10/07/2026 review decision).
--    The admin UI already gates the client-config page (and its Rules tab) to
--    contractor-admin (clients/[id]/page.tsx -> notFound() otherwise); these
--    policies bring the DB in line (defence-in-depth — client-tier roles could
--    previously write via PostgREST directly). Also closes the pre-existing
--    review finding that the INSERT policies lacked sub-client narrowing:
--    client-tier write access is removed entirely, so sub-client scoping on
--    these policies becomes moot (contractor roles are never sub-client-bound).
--    DROP+CREATE (never ALTER) per the drift-proof convention; helper calls
--    wrapped in (select ...) per the auth_rls_initplan rule (CLAUDE.md §21).
--
-- 2. allocation_conversion_rule FKs: ON DELETE CASCADE -> RESTRICT (same
--    review). CASCADE is how the 2026-07-03 KWN swap-config wipe happened
--    silently; RESTRICT makes deleting an allocation rule that still backs a
--    conversion rule fail loudly instead. Legitimate removal now requires
--    deleting/deactivating the conversion rule first (contractor-admin, by
--    design — there is no UI for conversion rules in v1). The server action
--    maps the FK violation (23503) to a friendly message. Bonus: during the
--    release deploy window (migration applied, old delete-then-insert code
--    still live until Coolify cuts over) a KWN rules save now errors loudly
--    instead of silently re-wiping the freshly re-seeded rules.
--    NOTE: this migration is ordered AFTER 20260710000000 (the re-seed), which
--    still inserts under CASCADE semantics — ordering is load-bearing only in
--    the sense that both apply in the same release; the re-seed itself never
--    deletes.

-- ── 1. Write policies ───────────────────────────────────────────────────────

DROP POLICY IF EXISTS allocation_rules_admin_insert ON public.allocation_rules;
CREATE POLICY allocation_rules_admin_insert ON public.allocation_rules
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT current_user_role()) = 'contractor-admin'
    AND collection_area_id IN (
      SELECT id FROM public.collection_area
      WHERE client_id IN (SELECT accessible_client_ids())
    )
  );

DROP POLICY IF EXISTS allocation_rules_admin_update ON public.allocation_rules;
CREATE POLICY allocation_rules_admin_update ON public.allocation_rules
  FOR UPDATE TO authenticated
  USING (
    (SELECT current_user_role()) = 'contractor-admin'
    AND collection_area_id IN (
      SELECT id FROM public.collection_area
      WHERE client_id IN (SELECT accessible_client_ids())
    )
  );

DROP POLICY IF EXISTS allocation_rules_admin_delete ON public.allocation_rules;
CREATE POLICY allocation_rules_admin_delete ON public.allocation_rules
  FOR DELETE TO authenticated
  USING (
    (SELECT current_user_role()) = 'contractor-admin'
    AND collection_area_id IN (
      SELECT id FROM public.collection_area
      WHERE client_id IN (SELECT accessible_client_ids())
    )
  );

DROP POLICY IF EXISTS service_rules_admin_insert ON public.service_rules;
CREATE POLICY service_rules_admin_insert ON public.service_rules
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT current_user_role()) = 'contractor-admin'
    AND collection_area_id IN (
      SELECT id FROM public.collection_area
      WHERE client_id IN (SELECT accessible_client_ids())
    )
  );

DROP POLICY IF EXISTS service_rules_admin_update ON public.service_rules;
CREATE POLICY service_rules_admin_update ON public.service_rules
  FOR UPDATE TO authenticated
  USING (
    (SELECT current_user_role()) = 'contractor-admin'
    AND collection_area_id IN (
      SELECT id FROM public.collection_area
      WHERE client_id IN (SELECT accessible_client_ids())
    )
  );

DROP POLICY IF EXISTS service_rules_admin_delete ON public.service_rules;
CREATE POLICY service_rules_admin_delete ON public.service_rules
  FOR DELETE TO authenticated
  USING (
    (SELECT current_user_role()) = 'contractor-admin'
    AND collection_area_id IN (
      SELECT id FROM public.collection_area
      WHERE client_id IN (SELECT accessible_client_ids())
    )
  );

-- ── 2. CASCADE -> RESTRICT on the conversion-rule FKs ───────────────────────

ALTER TABLE public.allocation_conversion_rule
  DROP CONSTRAINT allocation_conversion_rule_from_allocation_rules_id_fkey,
  ADD CONSTRAINT allocation_conversion_rule_from_allocation_rules_id_fkey
    FOREIGN KEY (from_allocation_rules_id)
    REFERENCES public.allocation_rules(id) ON DELETE RESTRICT,
  DROP CONSTRAINT allocation_conversion_rule_to_allocation_rules_id_fkey,
  ADD CONSTRAINT allocation_conversion_rule_to_allocation_rules_id_fkey
    FOREIGN KEY (to_allocation_rules_id)
    REFERENCES public.allocation_rules(id) ON DELETE RESTRICT;
