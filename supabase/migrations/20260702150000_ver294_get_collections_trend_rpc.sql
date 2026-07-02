-- ============================================================================
-- VER-294 (PR-A) — get_collections_trend RPC (B1 delta: collections trend)
-- ============================================================================
-- Collections per month for the council dashboard trend card. In-DB
-- aggregation only (PostgREST max_rows=1000 silently truncates
-- row-fetch-then-aggregate — VV alone has thousands of booking_items).
--
-- Metric (mirrors the tested pure fn src/lib/reports/collections-trend.ts
-- EXACTLY — keep in sync):
--   * a "collection" = a booking that reached the field, using the
--     dashboard's established BC status set (Completed / Non-conformance /
--     Nothing Presented / Scheduled / Missed Collection), not soft-deleted
--   * each booking counts ONCE, in the month of its service date =
--     MIN(collection_date.date) across its booking_items (the schema allows
--     per-item dates; real carts share one — MIN is the deterministic tiebreak)
--   * months between the first and last observed month are gap-filled with 0;
--     the series is NOT extended to the current month (render concern, as is
--     the go-live-cliff label — history starts at platform adoption)
--   * bookings with no booking_item rows have no service date and are
--     excluded (unreachable via the booking flows — every path writes items)
--   * optional p_from/p_to bound the SERVICE DATE (inclusive) — the VER-297
--     standard period scope. A preset (week/month/FY, AWST boundaries
--     computed by the card) passes its bounds and sums the buckets; the
--     rolling-12 trendline passes p_from = 12 months back. NULL = unbounded.
--
-- Statuses are matched by enum value, not display name (§21 / PR #228 lesson:
-- booking_status enum values are code keys, service display names are not).
--
-- SECURITY DEFINER per the get_rect_sla template, so the explicit guards are
-- the ONLY scoping (decision 7A):
--   * tenant: p_client_id IN accessible_client_ids(), NULL-safe (IS NOT TRUE
--     — NULL-role callers fail closed), else zero rows
--   * sub-client: user_sub_client_allows_area(b.collection_area_id) — keyed
--     on the BOOKING scan (hundreds of rows), never on booking_item or a
--     ~100k-row scan (the 20260702140000 lesson: per-row helper calls on a
--     large scan measured ~20s/call on prod)
--
-- search_path pinned inline (§21); REVOKE below closes the default PUBLIC
-- EXECUTE grant in the same migration. No table locks → no lock_timeout.
-- ============================================================================

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
       AND b.status IN (
             'Completed'::booking_status,
             'Non-conformance'::booking_status,
             'Nothing Presented'::booking_status,
             'Scheduled'::booking_status,
             'Missed Collection'::booking_status
           )
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

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default — close it in the same
-- migration (§21), then grant the two roles that may call it.
REVOKE EXECUTE ON FUNCTION public.get_collections_trend(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_collections_trend(uuid, uuid, date, date) TO authenticated, service_role;
