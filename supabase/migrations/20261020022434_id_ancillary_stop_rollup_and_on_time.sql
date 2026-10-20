-- Illegal Dumping ancillary stops (#593 / PR #681): keep an ID job's booking
-- status and the on-time KPI meaning what they meant before the job gained a
-- second stop.
--
-- The push now gives an ID job with mattresses / e-waste / whitegoods ticked a
-- derived ancillary stop (no booking_item of its own) beside its
-- illegal_dumping stop.
--
-- 1. rollup_booking_status_from_stops: the rollup is "exception wins", so an
--    ancillary crew finding the mattress already gone (Nothing Presented) would
--    roll a job the bulk crew COLLECTED to Nothing Presented — and the reverse
--    for an ancillary-only job the bulk truck had nothing to take from. An ID
--    job is one clean-up: if any of its stops was Completed, the booking is
--    Completed. Otherwise exception-wins as before. A single-stop ID job rolls
--    up exactly as it always has; non-ID bookings are unchanged.
--
-- 2. get_on_time_monthly: the contractual on-time KPI is per stop. The derived
--    ID ancillary stop is left out so an ID job still counts once (by its own
--    stop) and the monthly series keeps its basis across the deploy. The SLA
--    card's period figure applies the same rule (src/lib/reports/on-time.ts
--    countsTowardOnTime).
--
-- Both are CREATE OR REPLACE from the live bodies (md5-checked against prod
-- 20/10/2026); search_path pins are re-declared, grants are kept.

CREATE OR REPLACE FUNCTION public.rollup_booking_status_from_stops()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pending   integer;
  v_ncn       integer;
  v_np        integer;
  v_completed integer;
  v_live      integer;  -- non-Cancelled terminal stops
  v_is_id     boolean;
  v_rollup    booking_status;
BEGIN
  -- Serialise rollups per booking. Without this, two crews closing the last
  -- two sibling stops concurrently each see the other as Pending in their
  -- READ COMMITTED snapshot, BOTH skip the rollup, and the booking strands
  -- in Scheduled forever (terminal stops are immutable, so nothing re-fires).
  -- After blocking here, the count statement below gets a fresh snapshot and
  -- sees the other transaction's committed terminal status. Same key scheme
  -- as the capacity RPCs.
  PERFORM pg_advisory_xact_lock(('x' || substr(NEW.booking_id::text, 1, 8))::bit(32)::bigint);

  SELECT
    count(*) FILTER (WHERE status = 'Pending'),
    count(*) FILTER (WHERE status = 'Non-conformance'),
    count(*) FILTER (WHERE status = 'Nothing Presented'),
    count(*) FILTER (WHERE status = 'Completed'),
    count(*) FILTER (WHERE status <> 'Cancelled')
  INTO v_pending, v_ncn, v_np, v_completed, v_live
  FROM collection_stop
  WHERE booking_id = NEW.booking_id;

  IF v_pending > 0 OR v_live = 0 THEN
    RETURN NULL;  -- stops still open, or everything cancelled — nothing to roll up
  END IF;

  -- Outstanding-stream guard (see header): a booked stream with no live stop
  -- is a collection still owed — a date move cancelled its stop and the new
  -- date hasn't locked yet. Stay Scheduled so the push EF (Confirmed/Scheduled
  -- fetch) revives the stream's stop when the moved-to date locks.
  IF EXISTS (
    SELECT 1
    FROM booking_item bi
    JOIN service s ON s.id = bi.service_id
    WHERE bi.booking_id = NEW.booking_id
      AND NOT EXISTS (
        SELECT 1 FROM collection_stop cs
        WHERE cs.booking_id = NEW.booking_id
          AND cs.stream = s.waste_stream
          AND cs.status <> 'Cancelled'
      )
  ) THEN
    RETURN NULL;
  END IF;

  SELECT type = 'Illegal Dumping' INTO v_is_id FROM booking WHERE id = NEW.booking_id;

  v_rollup := CASE
    -- An ID job is one clean-up across its bulk + derived ancillary stops (#593).
    WHEN v_is_id AND v_completed > 0 THEN 'Completed'::booking_status
    WHEN v_ncn > 0 THEN 'Non-conformance'::booking_status
    WHEN v_np  > 0 THEN 'Nothing Presented'::booking_status
    ELSE 'Completed'::booking_status
  END;

  UPDATE booking
  SET status = v_rollup
  WHERE id = NEW.booking_id
    AND (
      status = 'Scheduled'
      OR (
        current_setting('verco.closeout_correction', true) = 'on'
        AND status IN ('Completed', 'Non-conformance', 'Nothing Presented')
        AND status IS DISTINCT FROM v_rollup
      )
    );

  RETURN NULL;
END;
$$;

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
  JOIN booking b ON b.id = cs.booking_id
  WHERE cs.client_id = p_client_id
    AND cs.status = 'Completed'
    AND cs.completed_at IS NOT NULL
    -- #593: an ID job counts once, by its own stop, not its derived ancillary one.
    AND NOT (cs.stream = 'ancillary' AND b.type = 'Illegal Dumping')
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
