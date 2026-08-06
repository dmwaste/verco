-- Monthly client reports (invoice-backing PDF) — spec
-- docs/superpowers/specs/2026-08-06-monthly-client-reports-design.md
--
-- * client.legal_name — invoice counterparty name for the report footer.
--   client.name is the BRAND ("Verge Valet"); the counterparty is the
--   council ("Western Metropolitan Regional Council"). Nullable; consumers
--   fall back to name.
-- * get_client_monthly_report — long-format completed-collection counts for
--   one client + calendar month. Contractor-admin ONLY (this is the
--   operator's invoicing document, not a council-facing card — unlike
--   get_reports_monthly/get_mattress_daily which admit client-tier roles).
--   Two sources:
--     booked        booking_item units (actuals ?? booked) on Completed
--                   bookings, bucketed by the ITEM's collection date.
--     stop_mattress crew-logged collection_stop.mattress_count (VV-style
--                   tenants where client.mattress_closeout_stream is set),
--                   bucketed by the stop's as-dispatched date (§21: admin
--                   date corrections move the booking_item, never the stop).
--   Grouping is derived: client has sub_client rows -> group by sub-client,
--   else by collection area.

ALTER TABLE public.client
  ADD COLUMN IF NOT EXISTS legal_name text;

COMMENT ON COLUMN public.client.legal_name IS
  'Formal invoice-counterparty name for client-facing documents (monthly report footer). NULL = fall back to name.';

-- Slug-keyed backfill; no-ops on a fresh db reset (clients not migration-seeded).
UPDATE public.client SET legal_name = 'City of Kwinana'
 WHERE slug = 'kwn' AND legal_name IS NULL;
UPDATE public.client SET legal_name = 'Western Metropolitan Regional Council'
 WHERE slug = 'vergevalet' AND legal_name IS NULL;

CREATE OR REPLACE FUNCTION public.get_client_monthly_report(
  p_client_id uuid,
  p_month     date
)
 RETURNS TABLE(
   source       text,
   group_key    uuid,
   group_label  text,
   service_name text,
   waste_stream public.waste_stream,
   is_mattress  boolean,
   is_extra     boolean,
   units        bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_from   date := date_trunc('month', p_month)::date;
  v_to     date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_by_sub boolean;
BEGIN
  -- NULL-safe contractor-admin gate + tenant gate (§21: role gate alone is
  -- not enough; accessible_client_ids alone is not enough).
  IF (current_user_role() = 'contractor-admin') IS NOT TRUE
     OR (p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RETURN;
  END IF;

  v_by_sub := EXISTS (SELECT 1 FROM sub_client sc WHERE sc.client_id = p_client_id);

  RETURN QUERY
  SELECT 'booked'::text,
         CASE WHEN v_by_sub THEN sc.id ELSE ca.id END,
         CASE WHEN v_by_sub THEN coalesce(sc.name, 'Unassigned') ELSE ca.name END,
         s.name, s.waste_stream, s.is_mattress, bi.is_extra,
         sum(coalesce(bi.actual_services, bi.no_services))::bigint
    FROM booking_item bi
    JOIN booking b            ON b.id  = bi.booking_id
    JOIN collection_area ca   ON ca.id = b.collection_area_id
    LEFT JOIN sub_client sc   ON sc.id = ca.sub_client_id
    JOIN service s            ON s.id  = bi.service_id
    JOIN collection_date cd   ON cd.id = bi.collection_date_id
   WHERE b.client_id = p_client_id
     AND b.deleted_at IS NULL
     AND b.status = 'Completed'::booking_status
     AND cd.date >= v_from AND cd.date < v_to
   GROUP BY 2, 3, s.name, s.waste_stream, s.is_mattress, bi.is_extra

  UNION ALL
  SELECT 'stop_mattress'::text,
         CASE WHEN v_by_sub THEN sc.id ELSE ca.id END,
         CASE WHEN v_by_sub THEN coalesce(sc.name, 'Unassigned') ELSE ca.name END,
         'Mattress'::text, c.mattress_closeout_stream, true, false,
         sum(cs.mattress_count)::bigint
    FROM collection_stop cs
    JOIN client c             ON c.id  = cs.client_id
    JOIN booking b            ON b.id  = cs.booking_id
    JOIN collection_area ca   ON ca.id = b.collection_area_id
    LEFT JOIN sub_client sc   ON sc.id = ca.sub_client_id
    JOIN collection_date cd   ON cd.id = cs.collection_date_id
   WHERE cs.client_id = p_client_id
     AND c.mattress_closeout_stream IS NOT NULL
     AND cs.mattress_count IS NOT NULL
     AND b.deleted_at IS NULL
     AND b.status = 'Completed'::booking_status
     AND cd.date >= v_from AND cd.date < v_to
   GROUP BY 2, 3, c.mattress_closeout_stream;
END;
$function$;

-- Postgres grants EXECUTE to PUBLIC on creation (§21): staff-only DEFINER
-- RPCs must revoke anon/PUBLIC. authenticated keeps EXECUTE; the in-function
-- gate does the real filtering.
REVOKE EXECUTE ON FUNCTION public.get_client_monthly_report(uuid, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_client_monthly_report(uuid, date) TO authenticated, service_role;
