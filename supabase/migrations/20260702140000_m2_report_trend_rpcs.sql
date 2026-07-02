-- ============================================================================
-- M2 PR-A — trend/monthly report RPCs + period params (VER-294 / VER-297)
-- ============================================================================
-- Database layer for the M2 dashboard build (cards + period slicers +
-- rolling-12 trendlines). Ships ahead of the UI per the split-PR rule: the
-- Types-Freshness CI gens from prod, so these must be RELEASED before the
-- consumer PR can pass CI.
--
-- Contents (get_collections_trend deliberately NOT here — it ships in
-- 20260702150000 / PR #246, which owns the trend at booking-grain; this
-- migration carries the rest of the M2 database layer):
--   1. get_on_time_monthly     — completed + on-time stop counts per AWST
--      month (SQL mirror of src/lib/reports/on-time.ts: on-time when the
--      AWST date of completed_at equals collection_date.date). History
--      necessarily starts at the stops model — UI carries the go-live label.
--   2. get_notices_monthly     — NCN + NP raised per AWST month of
--      reported_at, split contractor_fault vs other, per table.
--   3. get_rect_sla / get_property_penetration — optional p_from/p_to period
--      params (VER-297 slicers). DROP + CREATE (new signature would otherwise
--      OVERLOAD and make PostgREST rpc calls ambiguous); named-arg callers on
--      the old 2-arg shape still resolve via the DEFAULTs, so the deployed UI
--      keeps working. DROP discards ACLs — grants re-applied below.
--      Period semantics: rect filters on notice reported_at (AWST date);
--      penetration filters the BOOKED half on booking created_at (AWST date)
--      — "properties that booked during the period"; the eligible denominator
--      stays point-in-time by design.
--
-- All functions: NULL-safe tenant guard ((… IN (SELECT accessible_client_ids()))
-- IS NOT TRUE), sub-client narrowing via user_sub_client_allows_area() (7A),
-- search_path re-declared, REVOKE PUBLIC/anon + GRANT authenticated/service_role.
-- Rolling window = current AWST month back 11 (now() is fine in STABLE fns).
-- No table locks taken; idempotent (OR REPLACE / DROP IF EXISTS).
-- ============================================================================

-- 1 ── On-time by month (trendline source; mirrors on-time.ts) ───────────────
CREATE OR REPLACE FUNCTION public.get_on_time_monthly(p_client_id uuid, p_area_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(month date, completed bigint, on_time bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Australia/Perth'))::date;
BEGIN
  IF (p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    date_trunc('month', cd.date)::date AS month,
    count(*)::bigint AS completed,
    count(*) FILTER (
      WHERE (cs.completed_at AT TIME ZONE 'Australia/Perth')::date = cd.date
    )::bigint AS on_time
  FROM collection_stop cs
  JOIN collection_date cd ON cd.id = cs.collection_date_id
  WHERE cs.client_id = p_client_id
    AND cs.status = 'Completed'
    AND cs.completed_at IS NOT NULL
    AND (p_area_id IS NULL OR cd.collection_area_id = p_area_id)
    AND user_sub_client_allows_area(cd.collection_area_id)
    AND cd.date >= (v_month_start - interval '11 months')::date
    AND cd.date <  (v_month_start + interval '1 month')::date
  GROUP BY 1
  ORDER BY 1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_on_time_monthly(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_on_time_monthly(uuid, uuid) TO authenticated, service_role;

-- 2 ── Notices raised by month, contractor-fault split (NCN + NP) ────────────
CREATE OR REPLACE FUNCTION public.get_notices_monthly(p_client_id uuid, p_area_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(month date, ncn_contractor bigint, ncn_other bigint, np_contractor bigint, np_other bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Australia/Perth'))::date;
BEGIN
  IF (p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH raised AS (
    SELECT
      date_trunc('month', (n.reported_at AT TIME ZONE 'Australia/Perth'))::date AS mo,
      'ncn'::text AS src,
      n.contractor_fault
    FROM non_conformance_notice n
    JOIN booking b ON b.id = n.booking_id
    WHERE n.client_id = p_client_id
      AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
      AND user_sub_client_allows_area(b.collection_area_id)
    UNION ALL
    SELECT
      date_trunc('month', (np.reported_at AT TIME ZONE 'Australia/Perth'))::date AS mo,
      'np'::text AS src,
      np.contractor_fault
    FROM nothing_presented np
    JOIN booking b ON b.id = np.booking_id
    WHERE np.client_id = p_client_id
      AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
      AND user_sub_client_allows_area(b.collection_area_id)
  )
  SELECT
    r.mo AS month,
    count(*) FILTER (WHERE r.src = 'ncn' AND r.contractor_fault)::bigint     AS ncn_contractor,
    count(*) FILTER (WHERE r.src = 'ncn' AND NOT r.contractor_fault)::bigint AS ncn_other,
    count(*) FILTER (WHERE r.src = 'np'  AND r.contractor_fault)::bigint     AS np_contractor,
    count(*) FILTER (WHERE r.src = 'np'  AND NOT r.contractor_fault)::bigint AS np_other
  FROM raised r
  WHERE r.mo >= (v_month_start - interval '11 months')::date
    AND r.mo <  (v_month_start + interval '1 month')::date
  GROUP BY 1
  ORDER BY 1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_notices_monthly(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_notices_monthly(uuid, uuid) TO authenticated, service_role;

-- 3a ── get_rect_sla: + p_from/p_to (reported_at window, AWST dates) ─────────
DROP FUNCTION IF EXISTS public.get_rect_sla(uuid, uuid);

CREATE FUNCTION public.get_rect_sla(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL::uuid,
  p_from      date DEFAULT NULL::date,
  p_to        date DEFAULT NULL::date
)
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
       AND (p_from IS NULL OR (n.reported_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
       AND (p_to   IS NULL OR (n.reported_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
    UNION ALL
    SELECT np.rescheduled_booking_id, np.reported_at
      FROM nothing_presented np
     WHERE np.client_id = p_client_id
       AND np.rescheduled_booking_id IS NOT NULL
       AND (p_from IS NULL OR (np.reported_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
       AND (p_to   IS NULL OR (np.reported_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
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

REVOKE EXECUTE ON FUNCTION public.get_rect_sla(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_rect_sla(uuid, uuid, date, date) TO authenticated, service_role;

-- 3b ── get_property_penetration: + p_from/p_to (booked-during-period) ───────
DROP FUNCTION IF EXISTS public.get_property_penetration(uuid, uuid);

CREATE FUNCTION public.get_property_penetration(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL::uuid,
  p_from      date DEFAULT NULL::date,
  p_to        date DEFAULT NULL::date
)
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
        AND (p_from IS NULL OR (b.created_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
        AND (p_to   IS NULL OR (b.created_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
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
        -- whole-client denominator. The denominator is point-in-time
        -- eligibility by design — the period params filter bookings only.
        AND user_sub_client_allows_area(ep.collection_area_id));
$function$;

REVOKE EXECUTE ON FUNCTION public.get_property_penetration(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_property_penetration(uuid, uuid, date, date) TO authenticated, service_role;
