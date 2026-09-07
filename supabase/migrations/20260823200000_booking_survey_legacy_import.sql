-- ============================================================================
-- booking_survey: allow legacy (Airtable) surveys without a Verco booking
-- ----------------------------------------------------------------------------
-- Why: WMRC's CSAT KPI (Reports page + Surveys summary) starts at zero on each
-- council's cutover day unless the Airtable survey history comes across. Most
-- of those surveys reference bookings that were never imported (pre-FY27, or
-- Stage-1 rows that got Verco refs), so a survey must be able to stand alone.
--
--   * booking_id becomes nullable (UNIQUE kept — NULLs don't collide).
--   * collection_area_id added: the council dimension every consumer needs,
--     trigger-filled from the booking for Verco-native rows, set directly for
--     legacy rows. NOT NULL after backfill.
--   * source ('verco' | 'airtable') + external_ref (Airtable Booking_Ref +
--     Create Date) with a partial UNIQUE so the importer is idempotent.
--   * A Verco-native survey must still carry a booking (CHECK).
--   * Staff SELECT/DELETE RLS re-keyed from user_sub_client_allows_booking()
--     (NULL → denied for unlinked rows) to user_sub_client_allows_area().
--   * get_reports_monthly CSAT block keys area off sv.collection_area_id.
-- Decision: Dan 23/08/2026 (VIN go-live prep). ADR to follow with PR-B.
-- ============================================================================

ALTER TABLE public.booking_survey ALTER COLUMN booking_id DROP NOT NULL;

ALTER TABLE public.booking_survey
  ADD COLUMN IF NOT EXISTS collection_area_id uuid REFERENCES public.collection_area(id),
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'verco',
  ADD COLUMN IF NOT EXISTS external_ref text;

UPDATE public.booking_survey s
   SET collection_area_id = b.collection_area_id
  FROM public.booking b
 WHERE b.id = s.booking_id
   AND s.collection_area_id IS NULL;

-- Fill the area from the booking for every Verco-native insert/update so the
-- two field server actions that create surveys need no change.
CREATE OR REPLACE FUNCTION public.booking_survey_fill_area()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.collection_area_id IS NULL AND NEW.booking_id IS NOT NULL THEN
    SELECT b.collection_area_id INTO NEW.collection_area_id
      FROM public.booking b WHERE b.id = NEW.booking_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_survey_fill_area ON public.booking_survey;
CREATE TRIGGER booking_survey_fill_area
  BEFORE INSERT OR UPDATE OF booking_id, collection_area_id ON public.booking_survey
  FOR EACH ROW EXECUTE FUNCTION public.booking_survey_fill_area();

ALTER TABLE public.booking_survey ALTER COLUMN collection_area_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_survey_collection_area ON public.booking_survey(collection_area_id);

ALTER TABLE public.booking_survey
  ADD CONSTRAINT booking_survey_source_check CHECK (source IN ('verco', 'airtable')),
  ADD CONSTRAINT booking_survey_native_has_booking CHECK (booking_id IS NOT NULL OR source <> 'verco');

CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_survey_external_ref
  ON public.booking_survey(source, external_ref) WHERE external_ref IS NOT NULL;

COMMENT ON COLUMN public.booking_survey.source IS 'verco = created by the field closeout; airtable = imported legacy survey (scripts/import-vv-surveys-csv.ts), may have no booking.';
COMMENT ON COLUMN public.booking_survey.external_ref IS 'Legacy identity (Airtable Booking_Ref|Create Date) — importer idempotency key.';

-- RLS: staff policies re-keyed to the area helper (booking may be NULL).
DROP POLICY IF EXISTS booking_survey_staff_select ON public.booking_survey;
CREATE POLICY booking_survey_staff_select ON public.booking_survey
  FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (
      is_client_staff()
      OR current_user_role() = ANY (ARRAY['contractor-admin'::app_role, 'contractor-staff'::app_role])
    )
    AND user_sub_client_allows_area(collection_area_id)
  );

DROP POLICY IF EXISTS booking_survey_staff_delete ON public.booking_survey;
CREATE POLICY booking_survey_staff_delete ON public.booking_survey
  FOR DELETE
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (
      is_client_staff()
      OR current_user_role() = ANY (ARRAY['contractor-admin'::app_role, 'contractor-staff'::app_role])
    )
    AND user_sub_client_allows_area(collection_area_id)
  );

-- get_reports_monthly: body identical to 20260705030000 except the CSAT
-- block no longer joins booking (search_path re-pinned — CREATE OR REPLACE
-- would otherwise drop it).
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
  -- Three series per key so each surface has its numerator:
  --   kind=1 → _n    count of valid ratings (shared denominator)
  --   kind=2 → _good count rated 4..5  (Surveys page "% rated 4+" WMRC KPI)
  --   kind=3 → _sum  SUM of rating values (Reports page average = sum/n)
  -- r.kind is in GROUP BY because the value aggregate branches on it.
  SELECT date_trunc('month', (sv.submitted_at AT TIME ZONE 'Australia/Perth'))::date,
         ('csat_' || r.key || CASE r.kind WHEN 1 THEN '_n' WHEN 2 THEN '_good' ELSE '_sum' END)::text,
         CASE r.kind
           WHEN 1 THEN count(*)
           WHEN 2 THEN count(*) FILTER (WHERE (sv.responses ->> r.col) IN ('4','5'))
           ELSE coalesce(sum((sv.responses ->> r.col)::int), 0)
         END::bigint
    FROM booking_survey sv
    CROSS JOIN (VALUES
      ('booking',  'booking_rating',    1), ('booking',  'booking_rating',    2), ('booking',  'booking_rating',    3),
      ('service',  'collection_rating', 1), ('service',  'collection_rating', 2), ('service',  'collection_rating', 3),
      ('overall',  'overall_rating',    1), ('overall',  'overall_rating',    2), ('overall',  'overall_rating',    3)
    ) AS r(key, col, kind)
   WHERE sv.client_id = p_client_id
     AND sv.submitted_at IS NOT NULL
     AND (sv.responses ->> r.col) ~ '^[1-5]$'
     -- Area keys off the survey's own collection_area_id (trigger-filled from
     -- the booking for Verco-native rows; set directly for source='airtable'
     -- legacy rows, which have no booking).
     AND (p_area_id IS NULL OR sv.collection_area_id = p_area_id)
     AND sv.collection_area_id IN (SELECT aa.id FROM allowed_area aa)
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
