-- ============================================================================
-- M2 PR-A (part 2) — monthly RPCs + period params (VER-297 / VER-294)
-- ============================================================================
-- Completes the M2 database layer alongside 20260702150000 (PR #246, which
-- owns get_collections_trend). Ships ahead of the UI per the split-PR rule:
-- Types-Freshness CI gens from prod, so these must be RELEASED before the
-- consumer PR can pass CI.
--
-- Contents:
--   1. get_on_time_monthly  — completed + on-time stop counts per AWST month
--      (SQL mirror of src/lib/reports/on-time.ts: on-time when the AWST date
--      of completed_at equals collection_date.date). History necessarily
--      starts at the June-2026 stops model — UI carries the go-live label.
--   2. get_notices_monthly  — NCN + NP raised per AWST month of reported_at,
--      split contractor_fault vs other, per table (VER-294 split card's
--      trendline source).
--   3. get_rect_sla / get_property_penetration — optional p_from/p_to period
--      params (VER-297 slicers). DROP + CREATE (a new signature via OR
--      REPLACE would OVERLOAD and make PostgREST rpc calls ambiguous);
--      named-arg callers on the old 2-arg shape still resolve via the
--      DEFAULTs, so the deployed UI keeps working. DROP discards ACLs —
--      grants re-applied below. Penetration's body BUILDS ON 20260702140000
--      (per-area guard keying — do not regress it to per-row).
--      Period semantics: rect windows notice reported_at (AWST date);
--      penetration windows the BOOKED half on booking created_at (AWST date)
--      — "properties that booked during the period"; the eligible denominator
--      stays point-in-time by design.
--
-- Conventions (uniform with 20260702150000's trend fn):
--   * signature (p_client_id, p_area_id, p_from, p_to); NULL = unbounded —
--     the card computes AWST preset boundaries (VER-297) and passes them;
--     the rolling-12 trendline passes p_from = 12 months back.
--   * NULL-safe tenant guard: (… IN (SELECT accessible_client_ids())) IS NOT TRUE
--   * sub-client narrowing (7A) keyed on collection_area.id so the planner
--     applies it at the AREA scan, never per fact row — the 20260702140000
--     lesson (per-row keying on a large scan measured ~20s/call on prod).
--     get_notices_monthly guards per booking row deliberately: its scan is
--     notices (low hundreds), the same class as penetration's booked half.
--   * search_path re-declared; REVOKE PUBLIC/anon + GRANT authenticated/
--     service_role in the same migration. No table locks → no lock_timeout.
-- ============================================================================

-- 1 ── On-time by month (trendline source; mirrors on-time.ts) ───────────────
CREATE OR REPLACE FUNCTION public.get_on_time_monthly(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL::uuid,
  p_from      date DEFAULT NULL::date,
  p_to        date DEFAULT NULL::date
)
 RETURNS TABLE(month date, completed bigint, on_time bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  JOIN collection_area ca ON ca.id = cd.collection_area_id
  WHERE cs.client_id = p_client_id
    AND cs.status = 'Completed'
    AND cs.completed_at IS NOT NULL
    AND (p_area_id IS NULL OR cd.collection_area_id = p_area_id)
    -- 7A sub-client narrowing, keyed per AREA (evaluated at the ca scan,
    -- ~10 rows) — never per stop row (20260702140000 lesson).
    AND user_sub_client_allows_area(ca.id)
    AND (p_from IS NULL OR cd.date >= p_from)
    AND (p_to   IS NULL OR cd.date <= p_to)
  GROUP BY 1
  ORDER BY 1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_on_time_monthly(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_on_time_monthly(uuid, uuid, date, date) TO authenticated, service_role;

-- 2 ── Notices raised by month, contractor-fault split (NCN + NP) ────────────
CREATE OR REPLACE FUNCTION public.get_notices_monthly(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL::uuid,
  p_from      date DEFAULT NULL::date,
  p_to        date DEFAULT NULL::date
)
 RETURNS TABLE(month date, ncn_contractor bigint, ncn_other bigint, np_contractor bigint, np_other bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH raised AS (
    -- Per-booking-row guard is deliberate here: the scan is notices (low
    -- hundreds), the same small-cardinality class as penetration's booked
    -- half — not the ~90k-row case the per-area keying exists for.
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
  WHERE (p_from IS NULL OR r.mo >= date_trunc('month', p_from)::date)
    AND (p_to   IS NULL OR r.mo <= p_to)
  GROUP BY 1
  ORDER BY 1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_notices_monthly(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_notices_monthly(uuid, uuid, date, date) TO authenticated, service_role;

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
     -- Per-booking-row keying is fine here (rebooked-notice scan, small).
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

-- 3b ── get_property_penetration: + p_from/p_to on the booked half ───────────
-- Body carried forward from 20260702140000 (per-AREA guard keying on ca.id —
-- the ~20s → 261ms fix). Only the p_from/p_to predicates are new.
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
        -- VER-287: eligible_properties/collection_area are public-SELECT
        -- (USING(true)) — RLS does not narrow this half. Keyed on ca.id so
        -- the guard is evaluated per collection area, never per eligible row
        -- (per-row keying measured at ~20s/call on prod — 20260702140000).
        AND user_sub_client_allows_area(ca.id)
        -- Eligible denominator is point-in-time by design — the period
        -- params window bookings only.
        AND (p_area_id IS NULL OR ep.collection_area_id = p_area_id));
$function$;

REVOKE EXECUTE ON FUNCTION public.get_property_penetration(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_property_penetration(uuid, uuid, date, date) TO authenticated, service_role;

-- 4 ── get_collections_trend: narrow to DELIVERED (Completed) bookings ───────
-- Dan's call (02/07) resolving the two parallel PR-A definitions: the
-- released reached-the-field set (incl. Scheduled) presented the fully-booked
-- July season as delivered work on day 2 of the first season, and NP/Missed
-- mean "nothing collected" per the council definitions doc §3. Rebooked-then-
-- completed collections count in the month the rebooked booking completes.
-- Forward migration (NOT an edit to 20260702150000 — that version was applied
-- to prod in release #248; editing an applied file only diverges fresh
-- replays). Body otherwise identical to 20260702150000. Mirror:
-- src/lib/reports/collections-trend.ts (caller-filtered; canonical set here).

CREATE OR REPLACE FUNCTION public.get_collections_trend(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL,
  p_from      date DEFAULT NULL,
  p_to        date DEFAULT NULL
)
RETURNS TABLE(month date, collections bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Tenant guard (SECURITY DEFINER bypasses RLS): unknown/other-tenant/
  -- NULL-role → zero rows (empty trend).
  IF (p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH booking_dates AS (
    SELECT min(cd.date) AS service_date
      FROM booking b
      JOIN booking_item bi ON bi.booking_id = b.id
      JOIN collection_date cd ON cd.id = bi.collection_date_id
     WHERE b.client_id = p_client_id
       AND b.deleted_at IS NULL
       AND b.status = 'Completed'::booking_status
       AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
       -- Sub-client refinement (decision 7A): narrowed admins get a narrowed
       -- trend; unscoped callers (sub_client_id IS NULL) are unaffected.
       AND user_sub_client_allows_area(b.collection_area_id)
     GROUP BY b.id
    -- Period scope (VER-297) applies to the booking's SERVICE DATE (its MIN
    -- item date), so a booking is in or out of a period as a whole.
    HAVING (p_from IS NULL OR min(cd.date) >= p_from)
       AND (p_to   IS NULL OR min(cd.date) <= p_to)
  ),
  bucketed AS (
    SELECT date_trunc('month', bd.service_date)::date AS m, count(*)::bigint AS c
      FROM booking_dates bd
     GROUP BY 1
  )
  SELECT gs.m::date AS month, COALESCE(bk.c, 0)::bigint AS collections
    FROM generate_series(
           (SELECT min(bt.m) FROM bucketed bt),
           (SELECT max(bt.m) FROM bucketed bt),
           interval '1 month') AS gs(m)
    LEFT JOIN bucketed bk ON bk.m = gs.m::date
   ORDER BY 1;
  -- generate_series(NULL, NULL, ...) yields no rows, so a client with zero
  -- eligible bookings gets an empty set (the card's empty state), not an error.
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_collections_trend(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_collections_trend(uuid, uuid, date, date) TO authenticated, service_role;
