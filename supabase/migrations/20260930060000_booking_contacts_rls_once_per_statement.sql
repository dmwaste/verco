-- ============================================================================
-- #603 hotfix: booking + contacts SELECT policies evaluate once per statement
-- ============================================================================
-- ~150 PostgREST statement timeouts every working day since 26/08 (8s staff
-- timeout), all from /admin/bookings: typing in its search fires a contacts
-- `full_name ilike` + the booking page with count=exact. 64 timeouts in the
-- 10:00 hour on 30/09 (WMRC council-staff training) — five more councils' staff
-- log in from 01/10.
--
-- Measured on prod 30/09 (real JWTs, rolled back, quiet server):
--   * booking_client_staff_select calls user_sub_client_allows_area(
--     collection_area_id) BARE — a SECURITY DEFINER call per row. Over VV's
--     4,710 bookings that predicate costs 956ms (sub-client-scoped user) /
--     494ms (whole-client) vs 3ms for the ADR 0019 once-per-statement shape.
--   * contacts_client_staff_select is a CORRELATED EXISTS on booking:
--     `Index Scan using idx_booking_contact … loops=7651` ≈ 1.0s of a 1.4s
--     contact search for a scoped officer — each probe re-runs booking RLS.
--   * The ilike itself is trivial (7.6k rows) — a trigram index would not help.
--
-- Fix (quals = prod pg_policies as of 30/09 + the change noted; semantics
-- identical):
--   * booking_client_staff_select / booking_field_select:
--       user_sub_client_allows_area(collection_area_id)
--     → (SELECT current_user_sub_client_id()) IS NULL
--       OR collection_area_id IN (<own sub-client's areas>)          [ADR 0019]
--     The area subquery runs under collection_area RLS, which (since
--     20260901010000) narrows a scoped user to the same sub-client; its
--     policies reference only own columns + JWT helpers, so no recursion.
--   * contacts_client_staff_select / contacts_contractor_select:
--       EXISTS (SELECT 1 FROM booking b WHERE b.contact_id = contacts.id AND …)
--     → id IN (SELECT b.contact_id FROM booking b WHERE …)
--     Uncorrelated → one hashed set per statement. The subquery still runs
--     under booking RLS, so sub-client narrowing holds exactly as before.
--
-- No new function → no generated-types churn. Idempotent (DROP IF EXISTS +
-- CREATE).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- booking
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS booking_client_staff_select ON public.booking;
CREATE POLICY booking_client_staff_select ON public.booking
FOR SELECT USING (
  client_id = (SELECT current_user_client_id())
  AND (SELECT is_client_staff())
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR collection_area_id IN (
      SELECT ca.id FROM collection_area ca
       WHERE ca.sub_client_id = (SELECT current_user_sub_client_id())
    )
  )
);

DROP POLICY IF EXISTS booking_field_select ON public.booking;
CREATE POLICY booking_field_select ON public.booking
FOR SELECT USING (
  client_id IN (SELECT accessible_client_ids())
  AND (SELECT is_field_user())
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR collection_area_id IN (
      SELECT ca.id FROM collection_area ca
       WHERE ca.sub_client_id = (SELECT current_user_sub_client_id())
    )
  )
);

-- ----------------------------------------------------------------------------
-- contacts
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS contacts_client_staff_select ON public.contacts;
CREATE POLICY contacts_client_staff_select ON public.contacts
FOR SELECT USING (
  (SELECT is_client_staff())
  AND id IN (
    SELECT b.contact_id FROM booking b
     WHERE b.client_id = (SELECT current_user_client_id())
  )
);

DROP POLICY IF EXISTS contacts_contractor_select ON public.contacts;
CREATE POLICY contacts_contractor_select ON public.contacts
FOR SELECT USING (
  ((SELECT current_user_role()) = ANY (ARRAY['contractor-admin'::app_role, 'contractor-staff'::app_role]))
  AND id IN (
    SELECT b.contact_id FROM booking b
     WHERE b.contractor_id = (SELECT current_user_contractor_id())
  )
);
