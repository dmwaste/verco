-- ============================================================================
-- Reports: monthly series for all-card sparklines + penetration service-date
-- anchor (design feedback 02/07 — VER-298 pulled forward)
--
--   1. get_reports_monthly — ONE long-format monthly RPC (month, series,
--      value) feeding every single-value card's rolling-12 sparkline in one
--      call. Series definitions MIRROR the tested pure fns exactly — a
--      sparkline must never disagree with its own card's headline:
--        bookings            non-cancelled bookings by SERVICE month
--                            (MIN item collection_date — trend-fn convention)
--        bc_eligible/bc_miss clean-collection inputs by service month
--                            (field-reaching statuses / contractor-fault NCN
--                            via booking_id — clean-collection.ts)
--        self_scope/self_served  self-service.ts: type IN (Residential, MUD),
--                            status <> Cancelled, created_via stamped
--                            (resident|admin|ranger|system); served=resident;
--                            by AWST created_at month (event anchor)
--        notif_tracked/notif_delivered  notification-reliability.ts: email
--                            only; tracked = delivered|opened|bounced|
--                            dropped|spam (case/space-insensitive);
--                            delivered = delivered|opened; by created_at
--        csat_{booking,service,overall}_{n,good}  survey responses key must
--                            be a 1..5 integer (regex, never a jsonb text
--                            compare — resident-satisfaction.ts); good=4..5;
--                            by AWST submitted_at month
--        tickets             service_ticket raised per AWST created_at month
--                            (volume trend for the two ticket SLA cards)
--      NOT here (documented gap, stays on VER-298): rect monthly (working-day
--      window maths) and a penetration monthly (stock metric, not a flow).
--
--   2. get_property_penetration — the booked half moves from created_at to
--      the SERVICE window (any item collection_date inside p_from..p_to).
--      created_at surfaced legacy-imported bookings under Last FY/Last month
--      (the same bug fixed app-side for the direct-query cards in PR #252).
--      Same signature — CREATE OR REPLACE keeps ACLs; INVOKER semantics for
--      the booked half stay (booking RLS narrows it).
--
-- Conventions (uniform with 20260702160000):
--   * NULL-safe tenant guard: (… IN (SELECT accessible_client_ids())) IS NOT TRUE
--   * 7A sub-client narrowing keyed per AREA on big scans; per-row on small
--     relations (notification_log, booking_survey, service_ticket — the
--     notices-monthly precedent)
--   * search_path pinned; REVOKE PUBLIC/anon + GRANT authenticated/
--     service_role on the NEW function. No table locks → no lock_timeout.
-- ============================================================================

-- 1 ── One monthly RPC for every sparkline ───────────────────────────────────
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
BEGIN
  IF (p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH svc AS (
    -- One service month per booking: MIN item collection_date (the
    -- get_collections_trend convention). Area + 7A narrowing keyed at the
    -- collection_area scan.
    SELECT b.id,
           b.status,
           date_trunc('month', min(cd.date))::date AS svc_month
      FROM booking b
      JOIN collection_area ca ON ca.id = b.collection_area_id
      JOIN booking_item bi ON bi.booking_id = b.id
      JOIN collection_date cd ON cd.id = bi.collection_date_id
     WHERE b.client_id = p_client_id
       AND b.deleted_at IS NULL
       AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
       AND user_sub_client_allows_area(ca.id)
     GROUP BY b.id, b.status
  ),
  svc_windowed AS (
    SELECT * FROM svc
     WHERE (p_from IS NULL OR svc.svc_month >= date_trunc('month', p_from)::date)
       AND (p_to   IS NULL OR svc.svc_month <= p_to)
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
  -- Self-service (event anchor: AWST created_at). k=1 → scope, k=2 → served.
  SELECT date_trunc('month', (b.created_at AT TIME ZONE 'Australia/Perth'))::date,
         CASE WHEN s.k = 1 THEN 'self_scope' ELSE 'self_served' END::text,
         count(*) FILTER (WHERE s.k = 1 OR b.created_via = 'resident')::bigint
    FROM booking b
    JOIN collection_area ca ON ca.id = b.collection_area_id
    CROSS JOIN (VALUES (1),(2)) AS s(k)
   WHERE b.client_id = p_client_id
     AND b.deleted_at IS NULL
     AND b.type IN ('Residential','MUD')
     AND b.status <> 'Cancelled'::booking_status
     AND b.created_via IN ('resident','admin','ranger','system')
     AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
     AND user_sub_client_allows_area(ca.id)
     AND (p_from IS NULL OR (b.created_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
     AND (p_to   IS NULL OR (b.created_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
   GROUP BY 1, 2

  UNION ALL
  -- Notification reliability, email only. Small relation: per-row narrowing
  -- via the booking's area; no area dimension by design (matches the card).
  SELECT date_trunc('month', (nl.created_at AT TIME ZONE 'Australia/Perth'))::date,
         CASE WHEN s.k = 1 THEN 'notif_tracked' ELSE 'notif_delivered' END::text,
         count(*) FILTER (
           WHERE s.k = 1
              OR lower(btrim(nl.delivery_status)) IN ('delivered','opened')
         )::bigint
    FROM notification_log nl
    LEFT JOIN booking b ON b.id = nl.booking_id
    CROSS JOIN (VALUES (1),(2)) AS s(k)
   WHERE nl.client_id = p_client_id
     AND nl.channel = 'email'
     AND lower(btrim(nl.delivery_status)) IN ('delivered','opened','bounced','dropped','spam')
     AND (b.id IS NULL OR user_sub_client_allows_area(b.collection_area_id))
     AND (p_from IS NULL OR (nl.created_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
     AND (p_to   IS NULL OR (nl.created_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
   GROUP BY 1, 2

  UNION ALL
  -- Customer satisfaction: valid 1..5 integer ratings only, regex-validated.
  -- kind=1 → _n (denominator), kind=2 → _good (rating 4..5).
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
     AND user_sub_client_allows_area(b.collection_area_id)
     AND (p_from IS NULL OR (sv.submitted_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
     AND (p_to   IS NULL OR (sv.submitted_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
   GROUP BY 1, 2

  UNION ALL
  -- Ticket volume per month (the two ticket SLA cards trend on workload).
  SELECT date_trunc('month', (st.created_at AT TIME ZONE 'Australia/Perth'))::date,
         'tickets'::text,
         count(*)::bigint
    FROM service_ticket st
    LEFT JOIN booking b ON b.id = st.booking_id
   WHERE st.client_id = p_client_id
     AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
     AND (b.id IS NULL OR user_sub_client_allows_area(b.collection_area_id))
     AND (p_from IS NULL OR (st.created_at AT TIME ZONE 'Australia/Perth')::date >= p_from)
     AND (p_to   IS NULL OR (st.created_at AT TIME ZONE 'Australia/Perth')::date <= p_to)
   GROUP BY 1

  ORDER BY 1, 2;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_reports_monthly(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_reports_monthly(uuid, uuid, date, date) TO authenticated, service_role;

-- 2 ── Penetration: booked half anchors on the SERVICE window ────────────────
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
