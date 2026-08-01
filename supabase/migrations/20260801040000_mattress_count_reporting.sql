-- Mattress counts in reports (#487 / BR-0033): KWN booking-derived series +
-- VV crew-logged count at bulk closeout.
--
-- The two tenants need the same report number from different sources:
--   * Kwinana books Mattress as its own ancillary service — the count already
--     exists as booking_item rows; nothing new to capture.
--   * Verge Valet rolls mattresses into the bulk booking — no per-mattress
--     record exists, so crews log the count when they close the bulk stop.
--
-- Three columns + one RPC:
--   * service.is_mattress — structural flag so the report NEVER keys off a
--     display name at runtime (service-name rename gotcha, #228). Backfilled
--     by name exactly once, here.
--   * client.mattress_closeout_stream — which pass (if any) logs a mattress
--     count at stop closeout. NULL = no prompt (KWN and future councils that
--     book mattresses as a service). Data-driven per §21: enabling a council
--     is an UPDATE, never a code change.
--   * collection_stop.mattress_count — the crew-logged count. Written in the
--     SAME UPDATE that terminalises the stop, so the existing
--     collection_stop_field_update policy (WITH CHECK terminal status)
--     already admits it — no RLS change. The enforce_stop_state_transition
--     identity pins deliberately do NOT cover it: it is a closeout-outcome
--     column like completed_at/completed_by, not dispatch identity.
--     NULL = never logged (e.g. stop closed by the booking-status sync
--     trigger, or a tenant with no closeout logging); 0 = crew logged zero.
--   * get_mattress_daily — day-granular long-format series for /admin/reports
--     (the reporter asked for per-day counts; the UI derives the monthly
--     sparkline from the same rows, one source of truth).
--
-- Consumers (field closeout gate + UI, reports card) land in a follow-up PR
-- after this releases (Types Freshness split). Until then the columns are
-- inert and the RPC returns only the KWN booked series.

ALTER TABLE public.service
  ADD COLUMN IF NOT EXISTS is_mattress boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.service.is_mattress IS
  'Structural flag for mattress reporting (#487) — the mattress series must never key off the display name (rename gotcha #228).';

-- One-time by-name backfill. Keyed on the current prod name; a fresh
-- `db reset` (services not migration-seeded) no-ops cleanly.
UPDATE public.service
SET is_mattress = true
WHERE lower(name) = 'mattress' AND NOT is_mattress;

ALTER TABLE public.client
  ADD COLUMN IF NOT EXISTS mattress_closeout_stream public.waste_stream;

COMMENT ON COLUMN public.client.mattress_closeout_stream IS
  'Stream whose stop closeout prompts the crew for a mattress count (#487). NULL = no prompt — the tenant books mattresses as a service (see service.is_mattress) or does not report them.';

-- Verge Valet: mattresses ride the general (bulk) pass. Slug-keyed +
-- predicated so a fresh reset or re-run no-ops.
UPDATE public.client
SET mattress_closeout_stream = 'general'
WHERE slug = 'vergevalet' AND mattress_closeout_stream IS NULL;

ALTER TABLE public.collection_stop
  ADD COLUMN IF NOT EXISTS mattress_count integer
    CHECK (mattress_count IS NULL OR mattress_count >= 0);

COMMENT ON COLUMN public.collection_stop.mattress_count IS
  'Crew-logged mattress units at closeout (#487) — only for stops whose client.mattress_closeout_stream matches the stop stream. Written atomically with the terminal status transition. NULL = never logged; 0 = crew logged zero.';

-- ---------------------------------------------------------------------------
-- get_mattress_daily — per-day mattress units for /admin/reports.
--
-- Long format (day, series, value), same access model as get_reports_monthly:
-- SECURITY DEFINER with tenant gate + staff-role gate (resident/strata/field/
-- ranger tokens carry a client_id in user_roles, so the tenant gate alone is
-- not enough); service_role bypasses both. Area narrowing reuses the
-- allowed_area sub-client pattern (7A: evaluated once per area, never per
-- fact row). NOT contractor-only (8A does not apply): mattress volumes are
-- the council's own waste data.
--
--   mattress_booked  KWN-style: booking_item units of is_mattress services,
--                    bucketed by the ITEM's collection date; actuals once
--                    closed out (MUD), booked quantity otherwise.
--   mattress_logged  VV-style: crew-logged collection_stop.mattress_count,
--                    bucketed by the stop's AS-DISPATCHED date (§21: the stop
--                    is the dispatched record; admin date corrections move
--                    the booking_item, never the stop).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_mattress_daily(
  p_client_id uuid,
  p_area_id   uuid DEFAULT NULL::uuid,
  p_from      date DEFAULT NULL::date,
  p_to        date DEFAULT NULL::date
)
 RETURNS TABLE(day date, series text, value bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_service boolean := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';
BEGIN
  IF ((p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE
      OR (current_user_role() IN ('contractor-admin','contractor-staff','client-admin','client-staff')) IS NOT TRUE)
     AND NOT v_service THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH allowed_area AS (
    SELECT ca.id
      FROM collection_area ca
     WHERE ca.client_id = p_client_id
       AND user_sub_client_allows_area(ca.id)
  )
  SELECT cd.date, 'mattress_booked'::text,
         sum(coalesce(bi.actual_services, bi.no_services))::bigint
    FROM booking_item bi
    JOIN service s ON s.id = bi.service_id AND s.is_mattress
    JOIN booking b ON b.id = bi.booking_id
    JOIN collection_date cd ON cd.id = bi.collection_date_id
   WHERE b.client_id = p_client_id
     AND b.deleted_at IS NULL
     AND b.status <> 'Cancelled'::booking_status
     AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
     AND b.collection_area_id IN (SELECT aa.id FROM allowed_area aa)
     AND (p_from IS NULL OR cd.date >= p_from)
     AND (p_to   IS NULL OR cd.date <= p_to)
   GROUP BY cd.date

  UNION ALL
  SELECT cd.date, 'mattress_logged'::text,
         sum(cs.mattress_count)::bigint
    FROM collection_stop cs
    JOIN collection_date cd ON cd.id = cs.collection_date_id
    JOIN booking b ON b.id = cs.booking_id
   WHERE cs.client_id = p_client_id
     AND cs.mattress_count IS NOT NULL
     AND b.deleted_at IS NULL
     AND (p_area_id IS NULL OR b.collection_area_id = p_area_id)
     AND b.collection_area_id IN (SELECT aa.id FROM allowed_area aa)
     AND (p_from IS NULL OR cd.date >= p_from)
     AND (p_to   IS NULL OR cd.date <= p_to)
   GROUP BY cd.date

  ORDER BY 1, 2;
END;
$function$;

-- Postgres grants EXECUTE to PUBLIC on creation (§21) — staff-gated DEFINER
-- RPCs must revoke anon explicitly.
REVOKE EXECUTE ON FUNCTION public.get_mattress_daily(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_mattress_daily(uuid, uuid, date, date) TO authenticated, service_role;
