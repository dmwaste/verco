-- ============================================================================
-- VER-287 follow-up — key the penetration sub-client guard per AREA, not per
-- eligible-property row (perf fix to 20260702130000, pre-release)
-- ============================================================================
-- 20260702130000 added user_sub_client_allows_area(ep.collection_area_id) to
-- get_property_penetration's eligible denominator. Because that predicate
-- references ep, the planner evaluates it once per eligible_properties row —
-- ~90k SECURITY DEFINER helper calls per Verge Valet request (each one a
-- user_roles lookup via auth.uid()). Measured on prod via rolled-back
-- impersonation: 19,844 ms per call. Re-keying the identical predicate on
-- ca.id lets the planner apply it at the collection_area scan (~10 rows):
-- 261 ms, byte-identical results (join condition ca.id = ep.collection_area_id
-- makes the two forms equivalent).
--
-- Only the eligible half changes. The booked half's per-row guard stays: it
-- scans bookings (~hundreds per client), and booking RLS already evaluates
-- the same helper per row for client-tier callers.
--
-- CREATE OR REPLACE resets proconfig → search_path re-declared (§21). ACLs
-- survive; REVOKE re-asserted (idempotent). No table locks → no lock_timeout.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_property_penetration(p_client_id uuid, p_area_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(booked bigint, eligible bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    (SELECT count(DISTINCT b.property_id)
       FROM booking b
      WHERE b.client_id = p_client_id
        AND b.property_id IS NOT NULL
        AND b.deleted_at IS NULL
        AND b.status <> 'Cancelled'::booking_status
        AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
        -- VER-287: explicit sub-client narrowing (booking RLS already narrows
        -- this INVOKER half for sub-client users; stated here so both halves
        -- visibly follow one rule).
        AND user_sub_client_allows_area(b.collection_area_id)),
    (SELECT count(*)
       FROM eligible_properties ep
       JOIN collection_area ca ON ca.id = ep.collection_area_id
      WHERE ca.client_id = p_client_id
        AND ca.client_id IN (SELECT accessible_client_ids())
        -- VER-287: eligible_properties/collection_area are public-SELECT
        -- (USING(true)) — RLS does not narrow this half. Keyed on ca.id so
        -- the guard is evaluated per collection area, never per eligible row
        -- (per-row keying measured at ~20s/call on prod — see header).
        AND user_sub_client_allows_area(ca.id)
        AND (p_area_id IS NULL OR ep.collection_area_id = p_area_id));
$function$;

REVOKE EXECUTE ON FUNCTION public.get_property_penetration(uuid, uuid) FROM PUBLIC, anon;
