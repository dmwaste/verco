-- ============================================================================
-- Sub-client narrowing on the side tables + field PII exclusion (30/09/2026)
-- ============================================================================
-- Hotfix ahead of the 01/10 WMRC changeover, when staff from five more councils
-- (EAS, FRE, SOP, SUB, VIC) get Verco logins. Follows the 23/09 PRIS privacy
-- review (P1) and ADR 0019 / migration 20260901010000, which narrowed the
-- core tables but not these.
--
-- Verified on prod 30/09 under real JWTs (rolled-back impersonation):
--   * a Peppermint-Grove-only client-staff user (user_roles.sub_client_id set)
--     read 8,855 OTHER-council notification_log rows (resident emails/mobiles
--     in to_address), 30 service tickets with no booking, 314 resident
--     profiles and the whole Verge Valet audit_log (264,677 rows). All within
--     their own client — client isolation holds; council isolation did not.
--   * a FIELD user read 26,440 notification_log rows, every one with a
--     to_address — Red Line #2 (crews receive zero contact PII).
--     notification_log_select used is_contractor_user(), which includes
--     'field' (CLAUDE.md §4: never use it on PII-gating policies).
--
-- Fix, per table (quals = prod pg_policies as of 30/09 + the change noted):
--   * notification_log  — role gate is now the explicit staff roles (drops
--     field); scoped users see only rows whose booking is in their sub-client
--     (rows with no booking are hidden from them).
--   * service_ticket    — scoped users no longer see tickets with no booking
--     (general enquiries have no council link; WMRC + D&M handle them).
--     ticket_response needs no change: its staff policy selects ticket ids
--     from service_ticket under the caller's RLS, so replies follow the ticket.
--   * profiles          — client-tier staff no longer see RESIDENT profiles
--     (CLAUDE.md §4 privacy rule; no client-tier screen reads them).
--   * audit_log         — scoped users see no audit rows for now (Dan, 30/09:
--     option B). Per-council audit history needs a sub-client tag on
--     audit_log + a backfill — after the freeze.
--
-- Unchanged by construction: every sub-client predicate is
-- `(SELECT current_user_sub_client_id()) IS NULL OR …` — NULL for anon,
-- residents, strata, field, contractor tiers and whole-client staff, so their
-- visibility is identical except where a change above names them.
--
-- Shape (measured on prod 30/09, count(*) under real JWTs, rolled back):
--   * notification_log uses an UNCORRELATED booking-id set for the caller's
--     sub-client (hashed subplan, once per statement — ADR 0019's shape).
--     The per-row DEFINER helper user_sub_client_allows_booking() gave the
--     same rows but cost +4s per count for a scoped user (5.4s vs 1.1s,
--     against an ~8s statement timeout). The inner booking read runs under
--     the caller's booking RLS, which is already narrowed to the same
--     sub-client — self-consistent. service_ticket (~125 rows) keeps the
--     per-row helper it already used.
--   * role gates on the two large tables (notification_log, audit_log) are
--     `(SELECT current_user_role())` → InitPlan, once per statement instead
--     of per row (the old bare is_client_staff()/is_contractor_user() pair
--     made a contractor-admin count of notification_log take 5.3s).
--   * no new function → no generated-types churn.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- notification_log
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS notification_log_select ON public.notification_log;
CREATE POLICY notification_log_select ON public.notification_log
FOR SELECT USING (
  client_id IN (SELECT accessible_client_ids())
  AND ((SELECT current_user_role()) = ANY (ARRAY['client-admin'::app_role, 'client-staff'::app_role, 'contractor-admin'::app_role, 'contractor-staff'::app_role]))
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR booking_id IN (
      SELECT b.id FROM booking b
       WHERE b.collection_area_id IN (
         SELECT ca.id FROM collection_area ca
          WHERE ca.sub_client_id = (SELECT current_user_sub_client_id())
       )
    )
  )
);

-- ----------------------------------------------------------------------------
-- service_ticket (staff)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS service_ticket_staff_select ON public.service_ticket;
CREATE POLICY service_ticket_staff_select ON public.service_ticket
FOR SELECT USING (
  client_id IN (SELECT accessible_client_ids())
  AND (is_client_staff() OR (current_user_role() = ANY (ARRAY['contractor-admin'::app_role, 'contractor-staff'::app_role])))
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR user_sub_client_allows_booking(booking_id)
  )
);

-- ----------------------------------------------------------------------------
-- profiles (staff)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS profiles_staff_select ON public.profiles;
CREATE POLICY profiles_staff_select ON public.profiles
FOR SELECT USING (
  (current_user_role() = ANY (ARRAY['contractor-admin'::app_role, 'contractor-staff'::app_role, 'client-admin'::app_role, 'client-staff'::app_role]))
  AND id IN (
    SELECT ur.user_id
      FROM user_roles ur
     WHERE ur.is_active = true
       AND (
         (
           (current_user_role() = ANY (ARRAY['contractor-admin'::app_role, 'contractor-staff'::app_role]))
           AND (ur.contractor_id = current_user_contractor_id() OR ur.client_id IN (SELECT accessible_client_ids()))
         )
         OR (
           (current_user_role() = ANY (ARRAY['client-admin'::app_role, 'client-staff'::app_role]))
           AND ur.client_id = current_user_client_id()
           AND ur.role <> 'resident'::app_role
         )
       )
  )
);

-- ----------------------------------------------------------------------------
-- audit_log
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS audit_log_select ON public.audit_log;
CREATE POLICY audit_log_select ON public.audit_log
FOR SELECT USING (
  client_id IN (SELECT accessible_client_ids())
  AND ((SELECT current_user_role()) = ANY (ARRAY['client-admin'::app_role, 'client-staff'::app_role, 'contractor-admin'::app_role, 'contractor-staff'::app_role]))
  AND (SELECT current_user_sub_client_id()) IS NULL
);
