-- ============================================================================
-- get_reports_monthly — CSAT series: average rating, not "% rated 4+" (05/07)
-- ============================================================================
-- The Customer Satisfaction cards + their rolling-12 sparklines now show the
-- AVERAGE rating (1..5) instead of the share of surveys rated 4+. The headline
-- averages are computed client-side from raw survey rows, but the sparkline is
-- fed by this RPC, which pre-buckets per month. An average needs sum/n — a
-- count of 4/5 ratings can't yield a mean — so the CSAT arm now emits:
--
--     csat_{booking,service,overall}_n     count of valid 1..5 ratings
--     csat_{booking,service,overall}_sum   SUM of those rating values  ← was _good
--
-- averagePoints() (monthly-series.ts) renders sum/n. This is a CREATE OR REPLACE
-- of the released 20260702180000 body — every other series arm, both gates, the
-- 8A contractor filter and the search_path pin are reproduced verbatim; ONLY the
-- CSAT UNION arm changed. r.kind moves into GROUP BY because the value aggregate
-- now branches on it (count for _n, sum for _sum). ACLs preserved by OR REPLACE;
-- REVOKE/GRANT re-stated for clarity. No table locks → no lock_timeout.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_reports_monthly(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL::uuid,
  p_from      date DEFAULT NULL::date,
  p_to        date DEFAULT NULL::date
)
 RETURNS TABLE(month date, series text, value bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_service    boolean := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';
  v_contractor boolean;
BEGIN
  -- Tenant gate + staff-role gate (review 02/07): resident/strata/field/
  -- ranger tokens carry a client_id in user_roles, so the tenant gate alone
  -- is not enough. service_role bypasses both (no user_roles row — a future
  -- server-side aggregator must not silently read empty).
  IF ((p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE
      OR (current_user_role() IN ('contractor-admin','contractor-staff','client-admin','client-staff')) IS NOT TRUE)
     AND NOT v_service THEN
    RETURN;
  END IF;
  -- Contractor-only series filter (decision 8A): council staff never receive
  -- the D&M ops-health series, on the shared fetch OR a direct /rpc/ call.
  -- service_role sees everything (server-side aggregation).
  v_contractor := (current_user_role() IN ('contractor-admin','contractor-staff')) IS TRUE OR v_service;

  RETURN QUERY
  WITH allowed_area AS (
    -- 7A narrowing evaluated ONCE PER AREA (~10 rows/client), never per fact
    -- row — the 20260702140000 lesson (per-row keying measured ~20s/call).
    SELECT ca.id
      FROM collection_area ca
     WHERE ca.client_id = p_client_id
       AND user_sub_client_allows_area(ca.id)
  ),
  svc AS (
    -- One service month per booking: MIN item collection_date (the
    -- get_collections_trend convention).
    SELECT b.id,
           b.status,
           date_trunc('month', min(cd.date))::date AS svc_month
      FROM booking b
      JOIN booking_item bi ON bi.booking_id = b.id
      JOIN collection_date cd ON cd.id = bi.collection_date_id
     WHERE b.client_id = p_client_id
       AND b.deleted_at IS NULL
       AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
       AND b.collection_area_id IN (SELECT aa.id FROM allowed_area aa)
     GROUP BY b.id, b.status
  ),
  svc_windowed AS (
    SELECT * FROM svc
     WHERE (p_from IS NULL OR svc.svc_month >= date_trunc('month', p_from)::date)
       AND (p_to   IS NULL OR svc.svc_month <= p_to)
  ),
  -- Rectification monthly: the get_rect_sla body bucketed by reported_at
  -- month (rebooked-and-Completed notices; completion instant from audit_log;
  -- ≤ 2 working days, weekdays minus WA holidays over (reported, completed]).
  rect_notices AS (
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
  rect_scored AS (
    SELECT
      date_trunc('month', (nt.reported_at AT TIME ZONE 'Australia/Perth'))::date AS rmonth,
      CASE
        WHEN c.completed_at IS NOT NULL
         AND (c.completed_at AT TIME ZONE 'Australia/Perth')::date
             >= (nt.reported_at AT TIME ZONE 'Australia/Perth')::date
         AND (
           SELECT count(*)
             FROM generate_series(
                    (nt.reported_at  AT TIME ZONE 'Australia/Perth')::date + 1,
                    (c.completed_at AT TIME ZONE 'Australia/Perth')::date,
                    interval '1 day') AS g(day)
            WHERE extract(isodow FROM g.day) < 6
              AND g.day::date NOT IN (SELECT date FROM public_holiday WHERE jurisdiction = 'WA')
         ) <= 2
        THEN 1 ELSE 0
      END AS rect_on_time
    FROM rect_notices nt
    JOIN booking rb ON rb.id = nt.rescheduled_booking_id
    CROSS JOIN LATERAL (
      SELECT (SELECT min(al.created_at)
                FROM audit_log al
               WHERE al.table_name = 'booking'
                 AND al.record_id  = rb.id
                 AND al.new_data->>'status' = 'Completed') AS completed_at
    ) c
   WHERE rb.status = 'Completed'::booking_status
     AND rb.deleted_at IS NULL
     AND (p_area_id IS NULL OR rb.collection_area_id = p_area_id)
     AND rb.collection_area_id IN (SELECT aa.id FROM allowed_area aa)
  ),
  -- First-response monthly: responded tickets by created_at month; within =
  -- first response inside 3 WORKING days (service-ticket-sla.ts semantics).
  -- Booking-less tickets fall back to client scope (matches ticket RLS).
  resp_scored AS (
    SELECT
      date_trunc('month', (st.created_at AT TIME ZONE 'Australia/Perth'))::date AS rmonth,
      CASE
        WHEN (
          SELECT count(*)
            FROM generate_series(
                   (st.created_at        AT TIME ZONE 'Australia/Perth')::date + 1,
                   (st.first_response_at AT TIME ZONE 'Australia/Perth')::date,
                   interval '1 day') AS g(day)
           WHERE extract(isodow FROM g.day) < 6
             AND g.day::date NOT IN (SELECT date FROM public_holiday WHERE jurisdiction = 'WA')
        ) <= 3
        THEN 1 ELSE 0
      END AS resp_within
    FROM service_ticket st
    LEFT JOIN booking b ON b.id = st.booking_id
   WHERE st.client_id = p_client_id
     AND st.first_response_at IS NOT NULL
     AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
     AND (b.id IS NULL OR b.collection_area_id IN (SELECT aa.id FROM allowed_area aa))
     AND (p_from IS NULL OR (st.created_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
     AND (p_to   IS NULL OR (st.created_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
  )

  -- Total bookings by service month (non-cancelled)
  SELECT s.svc_month, 'bookings'::text, count(*)::bigint
    FROM svc_windowed s
   WHERE s.status <> 'Cancelled'::booking_status
   GROUP BY 1

  UNION ALL
  -- Clean-collection inputs: bookings that reached the field
  SELECT s.svc_month, 'bc_eligible'::text, count(*)::bigint
    FROM svc_windowed s
   WHERE s.status IN ('Completed','Non-conformance','Nothing Presented','Scheduled','Missed Collection')
   GROUP BY 1

  UNION ALL
  SELECT s.svc_month, 'bc_miss'::text, count(DISTINCT s.id)::bigint
    FROM svc_windowed s
    JOIN non_conformance_notice n ON n.booking_id = s.id AND n.contractor_fault
   WHERE s.status IN ('Completed','Non-conformance','Nothing Presented','Scheduled','Missed Collection')
   GROUP BY 1

  UNION ALL
  -- Self-service (CONTRACTOR-ONLY, 8A). k=1 → scope, k=2 → served.
  SELECT date_trunc('month', (b.created_at AT TIME ZONE 'Australia/Perth'))::date,
         CASE WHEN s.k = 1 THEN 'self_scope' ELSE 'self_served' END::text,
         count(*) FILTER (WHERE s.k = 1 OR b.created_via = 'resident')::bigint
    FROM booking b
    CROSS JOIN (VALUES (1),(2)) AS s(k)
   WHERE v_contractor
     AND b.client_id = p_client_id
     AND b.deleted_at IS NULL
     AND b.type IN ('Residential','MUD')
     AND b.status <> 'Cancelled'::booking_status
     AND b.created_via IN ('resident','admin','ranger','system')
     AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
     AND b.collection_area_id IN (SELECT aa.id FROM allowed_area aa)
     AND (p_from IS NULL OR (b.created_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
     AND (p_to   IS NULL OR (b.created_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
   GROUP BY 1, 2

  UNION ALL
  -- Notification reliability (CONTRACTOR-ONLY, 8A), email only. Booking-less
  -- rows fall back to client scope; no area dimension by design.
  SELECT date_trunc('month', (nl.created_at AT TIME ZONE 'Australia/Perth'))::date,
         CASE WHEN s.k = 1 THEN 'notif_tracked' ELSE 'notif_delivered' END::text,
         count(*) FILTER (
           WHERE s.k = 1
              OR lower(btrim(nl.delivery_status)) IN ('delivered','opened')
         )::bigint
    FROM notification_log nl
    LEFT JOIN booking b ON b.id = nl.booking_id
    CROSS JOIN (VALUES (1),(2)) AS s(k)
   WHERE v_contractor
     AND nl.client_id = p_client_id
     AND nl.channel = 'email'
     AND lower(btrim(nl.delivery_status)) IN ('delivered','opened','bounced','dropped','spam')
     AND (b.id IS NULL OR b.collection_area_id IN (SELECT aa.id FROM allowed_area aa))
     AND (p_from IS NULL OR (nl.created_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
     AND (p_to   IS NULL OR (nl.created_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
   GROUP BY 1, 2

  UNION ALL
  -- Customer satisfaction: valid 1..5 integer ratings only, regex-validated.
  -- kind=1 → _n (count of valid ratings); kind=2 → _sum (SUM of the rating
  -- values) so the sparkline can render the monthly AVERAGE (sum/n), not a
  -- "% rated 4+". r.kind is in GROUP BY because the value aggregate branches on
  -- it (count for _n, sum for _sum).
  SELECT date_trunc('month', (sv.submitted_at AT TIME ZONE 'Australia/Perth'))::date,
         ('csat_' || r.key || CASE WHEN r.kind = 1 THEN '_n' ELSE '_sum' END)::text,
         CASE WHEN r.kind = 1
              THEN count(*)
              ELSE coalesce(sum((sv.responses ->> r.col)::int), 0)
         END::bigint
    FROM booking_survey sv
    JOIN booking b ON b.id = sv.booking_id
    CROSS JOIN (VALUES
      ('booking',  'booking_rating',    1), ('booking',  'booking_rating',    2),
      ('service',  'collection_rating', 1), ('service',  'collection_rating', 2),
      ('overall',  'overall_rating',    1), ('overall',  'overall_rating',    2)
    ) AS r(key, col, kind)
   WHERE sv.client_id = p_client_id
     AND sv.submitted_at IS NOT NULL
     AND (sv.responses ->> r.col) ~ '^[1-5]$'
     AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
     AND b.collection_area_id IN (SELECT aa.id FROM allowed_area aa)
     AND (p_from IS NULL OR (sv.submitted_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
     AND (p_to   IS NULL OR (sv.submitted_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
   GROUP BY 1, r.key, r.kind

  UNION ALL
  -- Ticket volume per month (Open Tickets card). Booking-less rows fall back
  -- to client scope (matches ticket RLS).
  SELECT date_trunc('month', (st.created_at AT TIME ZONE 'Australia/Perth'))::date,
         'tickets'::text,
         count(*)::bigint
    FROM service_ticket st
    LEFT JOIN booking b ON b.id = st.booking_id
   WHERE st.client_id = p_client_id
     AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
     AND (b.id IS NULL OR b.collection_area_id IN (SELECT aa.id FROM allowed_area aa))
     AND (p_from IS NULL OR (st.created_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
     AND (p_to   IS NULL OR (st.created_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
   GROUP BY 1

  UNION ALL
  SELECT rs.rmonth, 'rect_den'::text, count(*)::bigint
    FROM rect_scored rs GROUP BY 1
  UNION ALL
  SELECT rs.rmonth, 'rect_num'::text, COALESCE(sum(rs.rect_on_time), 0)::bigint
    FROM rect_scored rs GROUP BY 1

  UNION ALL
  SELECT ps.rmonth, 'resp_den'::text, count(*)::bigint
    FROM resp_scored ps GROUP BY 1
  UNION ALL
  SELECT ps.rmonth, 'resp_num'::text, COALESCE(sum(ps.resp_within), 0)::bigint
    FROM resp_scored ps GROUP BY 1

  ORDER BY 1, 2;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_reports_monthly(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_reports_monthly(uuid, uuid, date, date) TO authenticated, service_role;
