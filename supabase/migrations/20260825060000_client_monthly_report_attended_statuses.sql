-- The monthly client report bills ATTENDED collections, not just clean ones.
-- ADR 0017. Supersedes the counting rule set in 20260806153039.
--
-- What changed and why: the original RPC billed only bookings that finished
-- 'Completed', on the assumption that a non-conformance or a nothing-presented
-- was not chargeable and that the redo would bill instead. That assumption is
-- wrong commercially (confirmed 25/08/2026): D&M attends the property, and
-- both councils pay the normal rate for that attendance whatever the crew
-- finds there. The filter silently dropped every NCN and NP from the invoice
-- AND from the client's service-delivery statement — City of Kwinana July 2026
-- was short 420 units (1,428 shown against 1,848 attended), and the July
-- statement told the City we made 1,434 collections instead of 1,854.
--
-- Billable now = Completed | Non-conformance | Nothing Presented.
--   * Cancelled stays out: nobody attended.
--   * Scheduled stays out: the outcome is unknown, not free. A past-dated
--     booking still sitting on Scheduled is an unclosed job that must be
--     closed out BEFORE invoicing — leaving it out keeps it visible as a
--     shortfall instead of billing an outcome we never recorded.
--   * Rebooked stays out (ADR 0017): a failed job that has been re-attended
--     bills once, on the redo. The council is not charged twice for one
--     property because our first attempt missed it.
--   * Missed Collection stays out: no code path writes it and no booking has
--     ever held it, but were it revived it is a failure awaiting a redo, not
--     a delivered attendance.
-- This is deliberately NARROWER than the dashboard's "reached the field" set
-- (which also counts Scheduled and Missed Collection, see get_collections_trend).
-- The invoice and the dashboard will therefore differ by exactly the unclosed
-- work — that gap is the signal, not a bug.
--
-- stop_mattress branch widens to the same three statuses. A mattress the crew
-- physically loaded is billable even when the stop's overall outcome was a
-- non-conformance; the old Completed-only filter would have dropped a real
-- count. No units move today (every NCN stop carrying a count logged zero).
--
-- Everything else is unchanged from 20260806153039 and its header comment
-- still applies: sub-client vs area grouping, the is_mattress double-bill
-- guard for stream tenants, the date seam, the NULL 'Unassigned' bucket, and
-- the contractor-admin + accessible_client_ids gate.

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
 -- Re-pinned: CREATE OR REPLACE resets the search_path pin (§21).
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_from   date := date_trunc('month', p_month)::date;
  v_to     date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_by_sub boolean;
  v_has_mattress_stream boolean;
BEGIN
  -- NULL-safe contractor-admin gate + tenant gate (§21: role gate alone is
  -- not enough; accessible_client_ids alone is not enough).
  IF (current_user_role() = 'contractor-admin') IS NOT TRUE
     OR (p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RETURN;
  END IF;

  v_by_sub := EXISTS (SELECT 1 FROM sub_client sc WHERE sc.client_id = p_client_id);
  v_has_mattress_stream := EXISTS (
    SELECT 1 FROM client c2
     WHERE c2.id = p_client_id AND c2.mattress_closeout_stream IS NOT NULL);

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
     AND b.status = ANY (ARRAY[
           'Completed'::booking_status,
           'Non-conformance'::booking_status,
           'Nothing Presented'::booking_status
         ])
     AND NOT (s.is_mattress AND v_has_mattress_stream)
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
     AND cs.status = ANY (ARRAY[
           'Completed'::stop_status,
           'Non-conformance'::stop_status,
           'Nothing Presented'::stop_status
         ])
     AND cd.date >= v_from AND cd.date < v_to
   GROUP BY 2, 3, c.mattress_closeout_stream;
END;
$function$;

-- Grants survive CREATE OR REPLACE; re-stated so the current definition is
-- self-documenting (§21). Deliberately NOT granted to service_role:
-- current_user_role() is NULL for service callers, so the gate would return an
-- EMPTY set — a silent zero-count invoice. Fail loudly instead.
REVOKE EXECUTE ON FUNCTION public.get_client_monthly_report(uuid, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_client_monthly_report(uuid, date) TO authenticated;
