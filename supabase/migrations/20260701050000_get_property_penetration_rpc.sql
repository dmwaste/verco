-- ============================================================================
-- VER-179 SLA dashboard §3.9 — PENETRATION insight card
-- ============================================================================
-- Property penetration = distinct booked eligible properties / total eligible
-- properties, per client [+ area]. Computed server-side because PostgREST can't
-- COUNT(DISTINCT) and the ~110k-row eligible denominator can't be client-fetched
-- (eligible_properties has no client_id — it scopes only through collection_area).
--
-- SECURITY INVOKER: the `booked` count runs under the caller's own RLS (they see
-- only their client's bookings), and the `eligible` count is guarded by
-- accessible_client_ids() so a caller can never read another tenant's
-- eligible-property total. No is_eligible filter — every row is is_eligible=true
-- in prod (verified 2026-07-01); the metric denominator matches the spec exactly.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_property_penetration(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL
)
RETURNS TABLE(booked bigint, eligible bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (SELECT count(DISTINCT b.property_id)
       FROM booking b
      WHERE b.client_id = p_client_id
        AND b.property_id IS NOT NULL
        AND b.deleted_at IS NULL
        AND b.status <> 'Cancelled'::booking_status
        AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)),
    (SELECT count(*)
       FROM eligible_properties ep
       JOIN collection_area ca ON ca.id = ep.collection_area_id
      WHERE ca.client_id = p_client_id
        AND ca.client_id IN (SELECT accessible_client_ids())
        AND (p_area_id IS NULL OR ep.collection_area_id = p_area_id));
$$;

GRANT EXECUTE ON FUNCTION public.get_property_penetration(uuid, uuid) TO authenticated, service_role;
