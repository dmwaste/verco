-- Totals for the admin bookings screen (VER-323). WMRC reconciles D&M's monthly
-- invoices against Verco; the answer to "can we have an export" is no (resident
-- PII, 13/10/2026), so the screen counts for them instead: one server-side
-- aggregate over the WHOLE filtered result set, never a sum of fetched pages
-- (that would total only the visible page, and the list query is the one that
-- was timing out).
--
-- Counting rules are the invoice's, not a second opinion. Every rule below is
-- copied from get_client_monthly_report (20261021041452; ADR 0017 as amended by
-- ADR 0039) and src/__tests__/reports/client-monthly-billable-statuses.test.ts
-- fails if this body drifts from that one:
--   * units = coalesce(actual_services, no_services) per booking_item, bucketed
--     by the ITEM's collection date (the invoice month; a plain AWST date);
--   * billable = Completed | Non-conformance | Nothing Presented: attended
--     collections, billed at the normal rate. Cancelled, Scheduled, Rebooked
--     and Missed Collection are outside the billable total (ADR 0017);
--   * EXCEPT a Nothing Presented the office recorded as D&M's fault
--     (nothing_presented.contractor_fault, ADR 0039): the items on that stop's
--     waste stream are not billable, and nor is that stop's crew mattress count;
--   * soft-deleted bookings never count;
--   * a tenant that logs mattresses at closeout (mattress_closeout_stream) has
--     its is_mattress items dropped and the crew's collection_stop.mattress_count
--     counted instead, on the STOP's status and the STOP's date. A stop's date
--     can differ from its item's after a date override (one VV stop in
--     September 2026), so mattresses must not follow the booking.
--
-- Unlike the invoice, the tally returns EVERY status in the filtered set, each
-- row flagged `billable`, so the screen can show the billable subtotal and the
-- rest beside it. The flag is the only place the billable set lives for the UI
-- (no TypeScript copy). Our-fault Nothing Presented rows come back as status
-- 'Nothing Presented' with contractor_fault = true and billable = false, so the
-- screen lists them outside the billable total instead of losing them. A
-- booking counts as our-fault only when ALL its items are on our-fault streams;
-- a booking with one faulted stream still counts as billable, and only that
-- stream's units move.
--
-- Filters mirror the bookings list (empty array = no filter): statuses (booking
-- status; for crew-logged mattresses, the stop status, which uses the same
-- names), areas, booking types, services, collection-date range (inclusive).
-- A date or service filter keeps a booking in the counts only if one of its
-- items matches, as the list's booking_item!inner join does. The free-text
-- search is deliberately not a parameter: the screen hides the totals while a
-- search is active, so this function never matches on names or addresses.
--
-- Access: staff roles only (contractor-admin/-staff, client-admin/-staff), for
-- a client in accessible_client_ids(). Council-scoped staff (user_roles.
-- sub_client_id) are narrowed to their own council's areas whatever areas they
-- pass. Both guards key on collection_area, the small relation (VER-287:
-- per-fact-row helper calls measured 19.8s vs 0.26s on prod). A caller who
-- fails the gate gets an error, not an empty result: an empty tally reads as
-- "zero bookings", which is a wrong number, not a refusal.
--
-- Returns counts and codes only, no resident PII:
--   { "bookings": [ { status, billable, contractor_fault, bookings } ],
--     "units":    [ { source: 'booked', status, billable, contractor_fault,
--                     category, service, is_extra, units }
--                 | { source: 'stop_mattress', status, billable,
--                     contractor_fault, units } ] }

CREATE OR REPLACE FUNCTION public.get_booking_tally(
  p_client_id   uuid,
  p_statuses    public.booking_status[] DEFAULT NULL,
  p_area_ids    uuid[]                  DEFAULT NULL,
  p_types       public.booking_type[]   DEFAULT NULL,
  p_service_ids uuid[]                  DEFAULT NULL,
  p_date_from   date                    DEFAULT NULL,
  p_date_to     date                    DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_statuses    public.booking_status[] := nullif(p_statuses, '{}');
  v_area_ids    uuid[]                  := nullif(p_area_ids, '{}');
  v_types       public.booking_type[]   := nullif(p_types, '{}');
  v_service_ids uuid[]                  := nullif(p_service_ids, '{}');
  v_item_filter boolean;
  v_sub         uuid;
  v_has_mattress_stream boolean;
  v_mattress_selected   boolean;
  v_result      jsonb;
BEGIN
  -- NULL-safe staff-role gate + tenant gate (§21: neither alone is enough).
  IF (current_user_role() IN ('contractor-admin','contractor-staff','client-admin','client-staff')) IS NOT TRUE
     OR (p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RAISE EXCEPTION 'get_booking_tally: not permitted for this client'
      USING ERRCODE = '42501';
  END IF;

  v_sub := current_user_sub_client_id();
  v_item_filter := p_date_from IS NOT NULL OR p_date_to IS NOT NULL OR v_service_ids IS NOT NULL;
  v_has_mattress_stream := EXISTS (
    SELECT 1 FROM client c2
     WHERE c2.id = p_client_id AND c2.mattress_closeout_stream IS NOT NULL);
  -- Crew-logged mattresses have no service of their own; they answer to the
  -- is_mattress service in the service filter.
  v_mattress_selected := v_service_ids IS NULL OR EXISTS (
    SELECT 1 FROM service s2 WHERE s2.id = ANY (v_service_ids) AND s2.is_mattress);

  WITH area AS (
    SELECT ca.id
      FROM collection_area ca
     WHERE ca.client_id = p_client_id
       AND (v_sub IS NULL OR ca.sub_client_id = v_sub)
       AND (v_area_ids IS NULL OR ca.id = ANY (v_area_ids))
  ),
  bk AS (
    SELECT b.id, b.status,
           b.status = ANY (ARRAY[
             'Completed'::booking_status,
             'Non-conformance'::booking_status,
             'Nothing Presented'::booking_status
           ]) AS attended
      FROM booking b
      JOIN area ON area.id = b.collection_area_id
     WHERE b.client_id = p_client_id
       AND b.deleted_at IS NULL
       AND (v_types IS NULL OR b.type = ANY (v_types))
  ),
  -- One row per booking_item in scope, flagged when its waste stream had an
  -- our-fault Nothing Presented (ADR 0039; same predicate as the invoice RPC).
  items AS (
    SELECT bi.booking_id, b.status, b.attended, cat.code AS category,
           s.name AS service, bi.is_extra,
           coalesce(bi.actual_services, bi.no_services) AS units,
           EXISTS (
             SELECT 1
               FROM nothing_presented np
               LEFT JOIN collection_stop npcs ON npcs.id = np.collection_stop_id
              WHERE np.booking_id = b.id
                AND np.contractor_fault
                AND (np.collection_stop_id IS NULL OR npcs.stream = s.waste_stream)) AS np_fault
      FROM bk b
      JOIN booking_item bi    ON bi.booking_id = b.id
      JOIN service s          ON s.id  = bi.service_id
      JOIN category cat       ON cat.id = s.category_id
      JOIN collection_date cd ON cd.id = bi.collection_date_id
     WHERE (v_statuses IS NULL OR b.status = ANY (v_statuses))
       AND NOT (s.is_mattress AND v_has_mattress_stream)
       AND (p_date_from IS NULL OR cd.date >= p_date_from)
       AND (p_date_to   IS NULL OR cd.date <= p_date_to)
       AND (v_service_ids IS NULL OR bi.service_id = ANY (v_service_ids))
  ),
  counted AS (
    SELECT bk.status, bk.attended,
           -- Our fault as a whole only when no item sits outside a faulted stream.
           EXISTS (SELECT 1 FROM items it WHERE it.booking_id = bk.id AND it.np_fault)
             AND NOT EXISTS (SELECT 1 FROM items it WHERE it.booking_id = bk.id AND NOT it.np_fault)
             AS np_fault
      FROM bk
     WHERE (v_statuses IS NULL OR bk.status = ANY (v_statuses))
       AND (NOT v_item_filter OR EXISTS (
             SELECT 1
               FROM booking_item bi
               JOIN collection_date cd ON cd.id = bi.collection_date_id
              WHERE bi.booking_id = bk.id
                AND (p_date_from IS NULL OR cd.date >= p_date_from)
                AND (p_date_to   IS NULL OR cd.date <= p_date_to)
                AND (v_service_ids IS NULL OR bi.service_id = ANY (v_service_ids))))
  ),
  counts AS (
    SELECT CASE WHEN c.np_fault THEN 'Nothing Presented' ELSE c.status::text END AS status,
           c.attended AND NOT c.np_fault AS billable,
           c.np_fault AS contractor_fault,
           count(*)::bigint AS bookings
      FROM counted c
     GROUP BY 1, 2, 3
  ),
  booked AS (
    SELECT CASE WHEN it.np_fault THEN 'Nothing Presented' ELSE it.status::text END AS status,
           it.attended AND NOT it.np_fault AS billable,
           it.np_fault AS contractor_fault,
           it.category, it.service, it.is_extra,
           sum(it.units)::bigint AS units
      FROM items it
     GROUP BY 1, 2, 3, it.category, it.service, it.is_extra
  ),
  stop_mattress AS (
    SELECT cs.status, NOT cs.np_fault AS billable, cs.np_fault AS contractor_fault,
           sum(cs.mattress_count)::bigint AS units
      FROM (
        SELECT cs.status::text AS status, cs.mattress_count,
               EXISTS (
                 SELECT 1 FROM nothing_presented np
                  WHERE np.collection_stop_id = cs.id AND np.contractor_fault) AS np_fault
          FROM bk
          JOIN collection_stop cs ON cs.booking_id = bk.id
          JOIN collection_date cd ON cd.id = cs.collection_date_id
         WHERE v_has_mattress_stream
           AND v_mattress_selected
           AND cs.client_id = p_client_id
           AND cs.mattress_count IS NOT NULL
           AND cs.status = ANY (ARRAY[
                 'Completed'::stop_status,
                 'Non-conformance'::stop_status,
                 'Nothing Presented'::stop_status
               ])
           AND (v_statuses IS NULL OR cs.status::text = ANY (v_statuses::text[]))
           AND (p_date_from IS NULL OR cd.date >= p_date_from)
           AND (p_date_to   IS NULL OR cd.date <= p_date_to)
      ) cs
     GROUP BY cs.status, cs.np_fault
  )
  SELECT jsonb_build_object(
    'bookings', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'status', c.status, 'billable', c.billable,
               'contractor_fault', c.contractor_fault, 'bookings', c.bookings))
        FROM counts c), '[]'::jsonb),
    'units', coalesce((
      SELECT jsonb_agg(u.obj)
        FROM (
          SELECT jsonb_build_object(
                   'source', 'booked', 'status', bd.status, 'billable', bd.billable,
                   'contractor_fault', bd.contractor_fault,
                   'category', bd.category, 'service', bd.service,
                   'is_extra', bd.is_extra, 'units', bd.units) AS obj
            FROM booked bd
          UNION ALL
          SELECT jsonb_build_object(
                   'source', 'stop_mattress', 'status', sm.status, 'billable', sm.billable,
                   'contractor_fault', sm.contractor_fault, 'units', sm.units)
            FROM stop_mattress sm
        ) u), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.get_booking_tally(uuid, public.booking_status[], uuid[], public.booking_type[], uuid[], date, date) IS
  'Admin bookings screen totals (VER-323): bookings + units for the whole filtered set, billable + contractor_fault flags per row. Counting rules = get_client_monthly_report (ADR 0017, amended by ADR 0039), pinned by client-monthly-billable-statuses.test.ts. Staff roles, tenant- and sub-client-gated; counts only, no PII.';

-- Staff-only DEFINER RPC (§21): no anon/PUBLIC execute. Not granted to
-- service_role either: current_user_role() is NULL there, so the gate raises.
REVOKE EXECUTE ON FUNCTION public.get_booking_tally(uuid, public.booking_status[], uuid[], public.booking_type[], uuid[], date, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_booking_tally(uuid, public.booking_status[], uuid[], public.booking_type[], uuid[], date, date) TO authenticated;
