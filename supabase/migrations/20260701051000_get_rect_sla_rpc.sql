-- ============================================================================
-- VER-179 SLA dashboard §3.3 — RECT scorecard (rectification ≤ 2 WA working days)
-- ============================================================================
-- SECURITY DEFINER: the completion timestamp lives in audit_log (jsonb, keyed by
-- record_id + status), unioned across NCN + NP, joined to public_holiday with
-- working-day arithmetic — impractical as client round-trips, and audit_log is not
-- client-readable. Because it runs as owner (bypassing RLS) the tenant guard is
-- explicit: a caller may only read a client_id in their accessible set.
--
-- Mirrors the tested pure fn src/lib/reports/rect.ts EXACTLY:
--   denominator = NCN/NP whose rebooked booking reached Completed
--   numerator   = those whose audit-derived completion is ≤ 2 WA working days
--                 after the notice was issued
-- A Completed rebook with no audit completion row (pre-audit-trigger, migration
-- 20260416100000) scores as a fail by construction — matches rect.ts, and is
-- unreachable for post-go-live data (the audit trigger predates go-live).
--
-- Working-day rule mirrors src/lib/reports/working-days.ts: count AWST dates in the
-- half-open window (reported, completed] that are Mon–Fri and not a WA public
-- holiday. `AT TIME ZONE 'Australia/Perth'` == awstDateFromUtc (UTC+8, no DST).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_rect_sla(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL
)
RETURNS TABLE(numerator bigint, denominator bigint, pct numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
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

GRANT EXECUTE ON FUNCTION public.get_rect_sla(uuid, uuid) TO authenticated, service_role;
