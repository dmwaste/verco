-- ============================================================================
-- Sub-client narrowing on the public-SELECT tables (MOS incident, 01/09/2026)
-- ============================================================================
-- A sub-client-scoped staff user (VER-216 — e.g. a MOS-only client-staff under
-- Verge Valet) saw ALL of their client's data on /admin/properties,
-- /admin/collection-dates, /admin/allocations and in every area picker.
-- Verified on prod under a MOS JWT: booking RLS narrowed correctly (428 rows,
-- 1 area), but eligible_properties returned 90,919 rows (all 10 WMRC councils),
-- collection_date 585, collection_area 12.
--
-- Why: these tables carry a USING(true)-style public SELECT policy for the
-- unauthenticated /book flow. Postgres ORs SELECT policies, so the parallel
-- accessible_client_ids()-scoped `*_select` policies never constrain an
-- authenticated staff user — and neither policy applied sub-client narrowing.
-- VER-216 called app-layer filtering "the right defence" for these tables, but
-- the admin pages only ever filtered by client_id.
--
-- Fix: put the sub-client predicate INTO both SELECT policies on each table.
-- It is caller-based and defaults open — `current_user_sub_client_id()` is
-- NULL for anon, residents, strata, field, contractor tiers and whole-client
-- staff, so the first branch short-circuits (InitPlan, evaluated once per
-- statement) and their visibility is byte-identical to before. Only a user
-- with user_roles.sub_client_id set is narrowed, to rows whose
-- collection_area belongs to their sub-client. One rule everywhere — same
-- decision as VER-287 made for the aggregate report RPCs.
--
-- Shape rules (CLAUDE.md §21):
--   * stable helpers wrapped in `(select …)` → InitPlan, not per-row;
--   * the sub-client area set is an UNCORRELATED IN-subquery on
--     collection_area (hashed subplan, evaluated once per statement) — the
--     same shape the existing `*_select` policies already use for their
--     accessible_client_ids() area sets. collection_area is a ~dozens-row
--     table whose own policies reference only its own columns + JWT helpers,
--     so there is no recursion and the one-time inner scan is cheap. No new
--     DEFINER function (avoids generated-types churn / Types Freshness split
--     for a function with no TS consumer);
--   * the subquery runs under the caller's collection_area RLS, which after
--     this migration is narrowed to the same sub-client — self-consistent.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY. Safe to re-apply.
-- Policy quals below = prod pg_policies quals as of 01/09/2026 + the
-- sub-client predicate; nothing else changed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- collection_area — own-row compare
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS collection_area_public_select ON public.collection_area;
CREATE POLICY collection_area_public_select ON public.collection_area
FOR SELECT USING (
  is_active = true
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR sub_client_id = (SELECT current_user_sub_client_id())
  )
);

DROP POLICY IF EXISTS collection_area_select ON public.collection_area;
CREATE POLICY collection_area_select ON public.collection_area
FOR SELECT USING (
  client_id IN (SELECT accessible_client_ids())
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR sub_client_id = (SELECT current_user_sub_client_id())
  )
);

-- ----------------------------------------------------------------------------
-- eligible_properties
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS eligible_properties_public_select ON public.eligible_properties;
CREATE POLICY eligible_properties_public_select ON public.eligible_properties
FOR SELECT USING (
  (SELECT current_user_sub_client_id()) IS NULL
  OR collection_area_id IN (
    SELECT id FROM collection_area
     WHERE sub_client_id = (SELECT current_user_sub_client_id())
  )
);

DROP POLICY IF EXISTS eligible_properties_select ON public.eligible_properties;
CREATE POLICY eligible_properties_select ON public.eligible_properties
FOR SELECT USING (
  collection_area_id IN (
    SELECT id FROM collection_area
     WHERE client_id IN (SELECT accessible_client_ids())
  )
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR collection_area_id IN (
      SELECT id FROM collection_area
       WHERE sub_client_id = (SELECT current_user_sub_client_id())
    )
  )
);

-- ----------------------------------------------------------------------------
-- collection_date
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS collection_date_public_select ON public.collection_date;
CREATE POLICY collection_date_public_select ON public.collection_date
FOR SELECT USING (
  is_open = true
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR collection_area_id IN (
      SELECT id FROM collection_area
       WHERE sub_client_id = (SELECT current_user_sub_client_id())
    )
  )
);

DROP POLICY IF EXISTS collection_date_select ON public.collection_date;
CREATE POLICY collection_date_select ON public.collection_date
FOR SELECT USING (
  collection_area_id IN (
    SELECT id FROM collection_area
     WHERE client_id IN (SELECT accessible_client_ids())
  )
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR collection_area_id IN (
      SELECT id FROM collection_area
       WHERE sub_client_id = (SELECT current_user_sub_client_id())
    )
  )
);

-- ----------------------------------------------------------------------------
-- allocation_rules (public SELECT policy only — no parallel *_select exists)
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS allocation_rules_public_select ON public.allocation_rules;
CREATE POLICY allocation_rules_public_select ON public.allocation_rules
FOR SELECT USING (
  (SELECT current_user_sub_client_id()) IS NULL
  OR collection_area_id IN (
    SELECT id FROM collection_area
     WHERE sub_client_id = (SELECT current_user_sub_client_id())
  )
);

-- ----------------------------------------------------------------------------
-- service_rules
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS service_rules_public_select ON public.service_rules;
CREATE POLICY service_rules_public_select ON public.service_rules
FOR SELECT USING (
  (SELECT current_user_sub_client_id()) IS NULL
  OR collection_area_id IN (
    SELECT id FROM collection_area
     WHERE sub_client_id = (SELECT current_user_sub_client_id())
  )
);

DROP POLICY IF EXISTS service_rules_select ON public.service_rules;
CREATE POLICY service_rules_select ON public.service_rules
FOR SELECT USING (
  collection_area_id IN (
    SELECT id FROM collection_area
     WHERE client_id IN (SELECT accessible_client_ids())
  )
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR collection_area_id IN (
      SELECT id FROM collection_area
       WHERE sub_client_id = (SELECT current_user_sub_client_id())
    )
  )
);
