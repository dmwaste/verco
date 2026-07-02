-- ============================================================================
-- Reports: monthly series for all-card sparklines + penetration service-date
-- anchor + staff-role gate retrofit (design feedback + /review 02/07 —
-- VER-298 pulled forward)
--
--   1. get_reports_monthly — ONE long-format monthly RPC (month, series,
--      value) feeding every single-value card's rolling-12 sparkline in one
--      call. Series definitions MIRROR the tested pure fns exactly — a
--      sparkline must never disagree with its own card's headline:
--        bookings            non-cancelled bookings by SERVICE month
--                            (MIN item collection_date — trend-fn convention).
--                            NO live consumer yet (Total Bookings card was
--                            retired 02/07); kept for the VER-300 comparator
--                            family — drop if still unused then.
--        bc_eligible/bc_miss clean-collection inputs by service month
--                            (field-reaching statuses / contractor-fault NCN
--                            via booking_id — clean-collection.ts)
--        self_scope/self_served  self-service.ts: type IN (Residential, MUD),
--                            status <> Cancelled, created_via stamped
--                            (resident|admin|ranger|system); served=resident;
--                            by AWST created_at month. CONTRACTOR-ONLY series
--                            (decision 8A) — emitted only to contractor roles.
--        notif_tracked/notif_delivered  notification-reliability.ts: email
--                            only; tracked = delivered|opened|bounced|
--                            dropped|spam; delivered = delivered|opened; by
--                            created_at. CONTRACTOR-ONLY series (8A).
--        csat_{booking,service,overall}_{n,good}  survey responses key must
--                            be a 1..5 integer (regex, never a jsonb text
--                            compare — resident-satisfaction.ts); good=4..5;
--                            by AWST submitted_at month
--        tickets             service_ticket raised per AWST created_at month
--        rect_num/rect_den   rectification monthly (get_rect_sla body
--                            bucketed by reported_at month)
--        resp_num/resp_den   first response ≤ 3 WORKING days by created_at
--                            month ((start,end] weekdays minus WA holidays —
--                            service-ticket-sla.ts semantics)
--      Window params: callers pass month-start p_from (rolling-12 anchor) and
--      an AWST-today p_to. The svc-anchored arms truncate p_from to month
--      start; event arms filter raw AWST dates — p_from SHOULD be a month
--      start or the same response mixes full and partial months.
--      NOT here (documented gap, stays on VER-298): a penetration monthly
--      series (stock metric, not a flow).
--
--   2. STAFF-ROLE GATE (/review 02/07, security+adversarial): report
--      aggregates are staff-only. accessible_client_ids() alone is NOT
--      sufficient — resident/strata/field/ranger user_roles rows carry a
--      client_id, so end-user tokens passed the tenant gate and could read
--      council-wide aggregates via /rpc/. get_reports_monthly gates on the
--      four staff roles, and the SAME gate is retrofitted onto the released
--      SECURITY DEFINER report RPCs (get_rect_sla, get_collections_trend,
--      get_on_time_monthly, get_notices_monthly) below — closing the class
--      in one release. Bodies are byte-identical to the deployed definitions
--      (pg_get_functiondef, 02/07) apart from the gate. service_role BYPASSES
--      the gate (and the tenant gate — it has no user_roles row): server-side
--      aggregation (the client_kpi_monthly lane) must not silently read empty
--      through its own GRANT (red team 02/07). v_contractor stays role-based,
--      so a service-role caller of get_reports_monthly gets ALL series.
--
--   3. get_property_penetration — the booked half moves from created_at to
--      the SERVICE window (any item collection_date inside p_from..p_to).
--      created_at surfaced legacy-imported bookings under Last FY/Last month
--      (the same anchor bug fixed app-side in PR #252). Same signature —
--      CREATE OR REPLACE keeps ACLs; INVOKER semantics stay (booking RLS
--      narrows the booked half per caller, incl. residents), so no staff
--      gate is added here.
--
-- Conventions (uniform with 20260702160000):
--   * NULL-safe gates: (… IN (…)) IS NOT TRUE (§21)
--   * 7A sub-client narrowing via ONE allowed_area CTE — the helper runs
--     per AREA (~10 rows), never per fact row (20260702140000 lesson; the
--     notification_log arm was measured-class per-row before /review).
--     Booking-less service_ticket/notification_log rows fall back to
--     client-level scope, matching those tables' own RLS semantics.
--   * search_path pinned on every function; REVOKE PUBLIC/anon + GRANT
--     authenticated/service_role on the NEW function (retrofits keep ACLs
--     via OR REPLACE). No table locks → no lock_timeout.
-- ============================================================================

-- 1 ── One monthly RPC for every sparkline (staff-gated, role-filtered) ──────
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
  SELECT date_trunc('month', (sv.submitted_at AT TIME ZONE 'Australia/Perth'))::date,
         ('csat_' || r.key || CASE WHEN r.kind = 1 THEN '_n' ELSE '_good' END)::text,
         count(*) FILTER (
           WHERE r.kind = 1
              OR (sv.responses ->> r.col) IN ('4','5')
         )::bigint
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
   GROUP BY 1, 2

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

-- 2 ── Staff-role gate retrofit on the released report RPCs ──────────────────
-- Bodies are the deployed definitions (pg_get_functiondef, 02/07) with ONLY
-- the staff gate added after the tenant gate. OR REPLACE keeps ACLs.

CREATE OR REPLACE FUNCTION public.get_rect_sla(p_client_id uuid, p_area_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS TABLE(numerator bigint, denominator bigint, pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Tenant guard (SECURITY DEFINER bypasses RLS): unknown/other-tenant → empty.
  -- Staff-role gate (review 02/07): aggregates are staff-only — end-user
  -- roles carry a client_id in user_roles, so the tenant gate alone is not
  -- sufficient. NULL-safe per §21.
  IF ((p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE
      OR (current_user_role() IN ('contractor-admin','contractor-staff','client-admin','client-staff')) IS NOT TRUE)
     AND coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role' THEN
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

CREATE OR REPLACE FUNCTION public.get_collections_trend(p_client_id uuid, p_area_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS TABLE(month date, collections bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Tenant guard + staff-role gate (review 02/07) — see get_rect_sla note.
  IF ((p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE
      OR (current_user_role() IN ('contractor-admin','contractor-staff','client-admin','client-staff')) IS NOT TRUE)
     AND coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role' THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.get_on_time_monthly(p_client_id uuid, p_area_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS TABLE(month date, completed bigint, on_time bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Tenant guard + staff-role gate (review 02/07) — see get_rect_sla note.
  IF ((p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE
      OR (current_user_role() IN ('contractor-admin','contractor-staff','client-admin','client-staff')) IS NOT TRUE)
     AND coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role' THEN
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

CREATE OR REPLACE FUNCTION public.get_notices_monthly(p_client_id uuid, p_area_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS TABLE(month date, ncn_contractor bigint, ncn_other bigint, np_contractor bigint, np_other bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Tenant guard + staff-role gate (review 02/07) — see get_rect_sla note.
  IF ((p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE
      OR (current_user_role() IN ('contractor-admin','contractor-staff','client-admin','client-staff')) IS NOT TRUE)
     AND coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role' THEN
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

-- 3 ── Penetration: booked half anchors on the SERVICE window ────────────────
-- INVOKER (booking RLS narrows the booked half per caller) — no staff gate.
CREATE OR REPLACE FUNCTION public.get_property_penetration(
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
        -- Service-date window (design 02/07): created_at surfaced
        -- legacy-imported bookings under Last FY / Last month.
        AND ((p_from IS NULL AND p_to IS NULL) OR EXISTS (
              SELECT 1
                FROM booking_item bi
                JOIN collection_date cd ON cd.id = bi.collection_date_id
               WHERE bi.booking_id = b.id
                 AND (p_from IS NULL OR cd.date >= p_from)
                 AND (p_to   IS NULL OR cd.date <= p_to)))
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
