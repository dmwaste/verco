-- Perf: InitPlan-wrap booking's four SELECT policies (auth_rls_initplan).
--
-- booking's SELECT policies called session-scoped helpers BARE, so Postgres
-- re-evaluated them for every row of the scan. Measured under a contractor-admin
-- JWT on prod (`select id from booking`, ~1,378 rows):
--   BEFORE  597 ms  (63,630 shared buffer hits — per-row helper churn)
--   AFTER   5.3 ms  (helpers hoisted to InitPlan; 591 buffer hits) — identical row set.
--
-- Every wrapped call is a STABLE function whose value is constant for the whole
-- query (`current_user_*` / `is_*` read the JWT, not the row), so `(select f())`
-- returns the same result as a per-row `f()` — this is a pure evaluation-count
-- change, zero visibility change. `user_sub_client_allows_area(collection_area_id)`
-- and the `accessible_client_ids()` IN-subquery are row-correlated / already
-- hoisted respectively, so they are left as-is.
--
-- First table of the repo-wide auth_rls_initplan sweep. booking's WRITE policies
-- also call helpers bare but fire once per (single-row) write, so they carry no
-- measurable cost and are deferred to the broader sweep.
-- See docs/superpowers/plans/2026-07-09-collection-stop-rls-timeout.md + memory
-- verco-rls-initplan-timeout.md.

alter policy booking_client_staff_select on public.booking
using (
  (client_id = (select current_user_client_id()))
  and (select is_client_staff())
  and user_sub_client_allows_area(collection_area_id)
);

alter policy booking_contractor_select on public.booking
using (
  (contractor_id = (select current_user_contractor_id()))
  and (select is_contractor_user())
);

alter policy booking_field_select on public.booking
using (
  (client_id in (select accessible_client_ids()))
  and (select is_field_user())
  and user_sub_client_allows_area(collection_area_id)
);

alter policy booking_resident_select on public.booking
using (
  ((contact_id = (select current_user_contact_id()))
    or (contact_id = (select current_user_contact_id_by_email())))
  and ((select current_user_role()) = any (array['resident', 'strata']::app_role[]))
);
