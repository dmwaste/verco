-- A Nothing Presented that was D&M's fault is not billed (ADR 0039, Dan
-- 21/10/2026). Amends the counting rule set in 20260825060000 (ADR 0017).
--
-- ADR 0017 bills Nothing Presented because D&M attended the property and the
-- resident put nothing out. That reasoning fails when the office, on
-- investigating a dispute, records the notice as contractor_fault: then the
-- crew missed or mis-closed a collection that was there, and the council is
-- not charged for our mistake. So:
--
--   * booked units drop out when the item's waste stream has a
--     nothing_presented record with contractor_fault = true. Fault is recorded
--     per stop (booking x stream), so a booking that was Nothing Presented on
--     green by our fault still bills its general items. A record with no stop
--     (legacy, booking-level) takes the whole booking out;
--   * crew-logged mattresses drop out when their stop's Nothing Presented is
--     contractor_fault (no units move today; NP stops log zero).
--
-- Unchanged: Non-conformance is billed whatever its contractor_fault flag (not
-- part of this decision). A contractor-fault NP that was rebooked was already
-- excluded (Rebooked), and its redo bills at price 0 to the resident as before.
-- Every other rule and comment in 20260825060000 and 20260806153039 still
-- applies.
--
-- Effect on prod data at writing: 4 Verge Valet units in July 2026, all
-- contractor-fault NPs resolved without a rebook. August-October unchanged.
-- get_booking_tally (20261021032236) applies the identical predicate, and
-- client-monthly-billable-statuses.test.ts pins the two together.

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
     -- ADR 0039: our-fault Nothing Presented on this item's stream isn't billed.
     AND NOT EXISTS (
           SELECT 1
             FROM nothing_presented np
             LEFT JOIN collection_stop npcs ON npcs.id = np.collection_stop_id
            WHERE np.booking_id = b.id
              AND np.contractor_fault
              AND (np.collection_stop_id IS NULL OR npcs.stream = s.waste_stream))
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
     -- ADR 0039: our-fault Nothing Presented on this stop isn't billed.
     AND NOT EXISTS (
           SELECT 1 FROM nothing_presented np
            WHERE np.collection_stop_id = cs.id AND np.contractor_fault)
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
