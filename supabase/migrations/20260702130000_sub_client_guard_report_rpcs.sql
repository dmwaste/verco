-- ============================================================================
-- VER-287 — sub-client guard on the aggregate report RPCs (decision 7A)
-- ============================================================================
-- get_rect_sla (SECURITY DEFINER) and get_property_penetration (SECURITY
-- INVOKER) tenant-guard on accessible_client_ids() but apply no sub-client
-- narrowing, while every direct-RLS metric on /admin/reports does (the booking
-- policies call user_sub_client_allows_area()). A sub-client-scoped admin
-- (VER-216 — e.g. a COT-only client-admin under Verge Valet) therefore sees
-- whole-of-client SLA/penetration aggregates next to narrowed booking counts:
-- two scoping regimes on one page, and a deliberately-narrowed user is shown
-- regional data.
--
-- Fix: one rule everywhere — every aggregate applies
-- user_sub_client_allows_area(<area of the row>). The helper is SECURITY
-- DEFINER STABLE, returns true for whole-client users (user_roles.sub_client_id
-- IS NULL, incl. all contractor roles), so non-narrowed callers see no change.
--
--   * get_rect_sla: filter the rebooked booking's area in the `completed` CTE.
--   * get_property_penetration: the booked half runs as INVOKER so booking RLS
--     already narrows it for sub-client users — but the eligible denominator
--     reads public-SELECT tables (USING(true)) where RLS does NOT tenant- or
--     sub-client-scope, giving a narrowed numerator over a whole-client
--     denominator (wrong %, not just wide). Filter both halves explicitly so
--     the rule is visible in the definition, not implied by policy layering.
--
-- CREATE OR REPLACE preserves existing grants (authenticated EXECUTE; anon
-- revoked in 20260702080000/100000) and resets SET search_path — re-declared
-- here per §21. No table locks taken; no lock_timeout needed.
-- Idempotent: safe to re-apply.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_rect_sla(p_client_id uuid, p_area_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(numerator bigint, denominator bigint, pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
     -- VER-287: sub-client narrowing — aggregates match the caller's scope.
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
$function$;

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
        AND (p_area_id IS NULL OR ep.collection_area_id = p_area_id)
        -- VER-287: eligible_properties/collection_area are public-SELECT
        -- (USING(true)) — RLS does not narrow this half, so without this a
        -- sub-client-scoped caller got a narrowed numerator over a
        -- whole-client denominator.
        AND user_sub_client_allows_area(ep.collection_area_id));
$function$;
