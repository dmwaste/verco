-- ============================================================================
-- VER-287 — sub-client guard on aggregate RPCs (decision 7A)
-- ============================================================================
-- get_rect_sla + get_property_penetration guarded accessible_client_ids()
-- only: a sub-client-narrowed admin (VER-216, e.g. a COT-only Verge Valet
-- client-admin) saw whole-of-client aggregates while the direct-RLS metrics
-- on the same dashboard were narrowed. For penetration it is worse than a
-- leak: the `booked` numerator IS narrowed (SECURITY INVOKER → booking RLS
-- applies user_sub_client_allows_area) while the `eligible` denominator was
-- not (eligible_properties carries a public USING(true) SELECT policy), so a
-- scoped caller got a narrowed numerator over a whole-of-client denominator —
-- an understated, wrong percentage.
--
-- Fix: apply user_sub_client_allows_area() inside both RPCs — the same
-- scoping rule the RLS policies use (one rule everywhere, decision 7A).
-- Unscoped users (sub_client_id IS NULL) see exactly what they saw before;
-- scoped users see their subset. Every future aggregate RPC copies this.
--
-- CREATE OR REPLACE resets proconfig, so both definitions re-declare
-- SET search_path = public, pg_temp (§21 — the pin 20260702060000/100000
-- applied via ALTER would otherwise be lost here). ACLs survive CREATE OR
-- REPLACE; the REVOKEs below re-assert the 20260702080000/100000 posture
-- explicitly (idempotent no-ops when already revoked). No table-level
-- ACCESS EXCLUSIVE locks are taken → no lock_timeout needed.
-- ============================================================================

-- 1. get_rect_sla — SECURITY DEFINER bypasses RLS, so the explicit guards are
--    the ONLY scoping. Adds the sub-client refinement next to the existing
--    tenant guard. Filter keys on the rescheduled booking's area, matching
--    the existing p_area_id filter (a rebook lands at the same property, so
--    original and rescheduled bookings share a collection area).
CREATE OR REPLACE FUNCTION public.get_rect_sla(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL
)
RETURNS TABLE(numerator bigint, denominator bigint, pct numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Tenant guard (SECURITY DEFINER bypasses RLS): unknown/other-tenant → empty.
  IF (p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, NULL::numeric;
    RETURN;
  END IF;

  RETURN QUERY
  WITH notices AS (
    SELECT n.rescheduled_booking_id, n.reported_at
      FROM non_conformance_notice n
     WHERE n.client_id = p_client_id
       AND n.rescheduled_booking_id IS NOT NULL
    UNION ALL
    SELECT np.rescheduled_booking_id, np.reported_at
      FROM nothing_presented np
     WHERE np.client_id = p_client_id
       AND np.rescheduled_booking_id IS NOT NULL
  ),
  completed AS (
    SELECT
      nt.reported_at,
      (SELECT min(al.created_at)
         FROM audit_log al
        WHERE al.table_name = 'booking'
          AND al.record_id  = rb.id
          AND al.new_data->>'status' = 'Completed') AS completed_at
    FROM notices nt
    JOIN booking rb ON rb.id = nt.rescheduled_booking_id
   WHERE rb.status = 'Completed'::booking_status
     AND rb.deleted_at IS NULL
     AND (p_area_id IS NULL OR rb.collection_area_id = p_area_id)
     -- Sub-client refinement (VER-287, decision 7A): a sub-client-narrowed
     -- caller aggregates only their areas; unscoped callers are unchanged.
     AND user_sub_client_allows_area(rb.collection_area_id)
  ),
  scored AS (
    SELECT
      CASE
        WHEN c.completed_at IS NOT NULL
         AND (c.completed_at AT TIME ZONE 'Australia/Perth')::date
             >= (c.reported_at AT TIME ZONE 'Australia/Perth')::date
         AND (
           SELECT count(*)
             FROM generate_series(
                    (c.reported_at  AT TIME ZONE 'Australia/Perth')::date + 1,
                    (c.completed_at AT TIME ZONE 'Australia/Perth')::date,
                    interval '1 day') AS g(day)
            WHERE extract(isodow FROM g.day) < 6
              AND g.day::date NOT IN (SELECT date FROM public_holiday WHERE jurisdiction = 'WA')
         ) <= 2
        THEN 1 ELSE 0
      END AS on_time
    FROM completed c
  )
  SELECT
    COALESCE(sum(s.on_time), 0)::bigint AS numerator,
    count(*)::bigint                    AS denominator,
    CASE WHEN count(*) = 0 THEN NULL
         ELSE round(sum(s.on_time)::numeric / count(*) * 100, 1) END AS pct
  FROM scored s;
END;
$$;

-- 2. get_property_penetration — SECURITY INVOKER. The eligible denominator's
--    guard is applied against ca.id (not ep.collection_area_id) so the
--    planner evaluates it once per collection_area row, not once per
--    ~110k-row eligible_properties row. The booked numerator is already
--    narrowed by booking RLS for client-tier callers; the explicit guard
--    keeps the RPC's scoping self-contained per decision 7A (and correct
--    under any future invoker/definer change).
CREATE OR REPLACE FUNCTION public.get_property_penetration(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL
)
RETURNS TABLE(booked bigint, eligible bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(DISTINCT b.property_id)
       FROM booking b
      WHERE b.client_id = p_client_id
        AND b.property_id IS NOT NULL
        AND b.deleted_at IS NULL
        AND b.status <> 'Cancelled'::booking_status
        AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
        AND user_sub_client_allows_area(b.collection_area_id)),
    (SELECT count(*)
       FROM eligible_properties ep
       JOIN collection_area ca ON ca.id = ep.collection_area_id
      WHERE ca.client_id = p_client_id
        AND ca.client_id IN (SELECT accessible_client_ids())
        AND user_sub_client_allows_area(ca.id)
        AND (p_area_id IS NULL OR ep.collection_area_id = p_area_id));
$$;

-- Re-assert execution posture (idempotent — ACLs survive CREATE OR REPLACE,
-- but the standing rule is explicit revokes in every migration touching them).
REVOKE EXECUTE ON FUNCTION public.get_rect_sla(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_property_penetration(uuid, uuid) FROM PUBLIC, anon;
