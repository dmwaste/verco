-- Perf: fix contacts SELECT RLS (auth_rls_initplan + structural).
--
-- A contacts scan under a contractor-admin JWT measured 276 ms on prod (contacts
-- holds resident/strata PII; the admin contacts list, booking-detail embeds, and
-- ticket detail all read it). Wrapping the STABLE helpers alone only reached
-- 157 ms — two policies were structural.
--
-- Three parts:
--   A. (select …)-wrap the STABLE helpers in all 6 SELECT policies (current_user_*,
--      is_client_staff) so they hoist to InitPlan. accessible_client_ids() stays
--      `IN (SELECT …)` (never `= ANY` — SRF-in-scalar is a 0A000 hard-fail, PR #97/#99).
--   B. contacts_admin_strata_select: the EXISTS was planned as a scan of all 109,763
--      tenant properties. Rewrite to `id IN (SELECT ep.strata_contact_id …)` driven by
--      a partial index over the ~326 non-null strata_contact_id rows. BOTH role-gated
--      branches are copied verbatim — collapsing them would leak cross-tenant PII on an
--      unenforced data invariant.
--   C. via_profiles: helpers wrapped. Residual cost is user_roles/profiles' OWN unfixed
--      RLS (referenced inside the subquery) — addressed by the small-table sweep.
--
-- Measured after (contractor-admin, prod, rolled back): 276 → 65 ms. Strata subplan
-- now an Index Only Scan touching 326 rows, not 109k. Row set identical (contractor
-- 1513 = 1513; strata rewrite proven equivalent: 193 = 193 distinct strata contacts).
--
-- Semantics-preserving: STABLE-fn wraps are value-identical; the IN-rewrite is
-- provably the same set (only correlation is strata_contact_id = contacts.id; NULLs
-- excluded either way; duplicates/shared-tenant identical). Plan + review:
-- docs/superpowers/plans/2026-07-09-contacts-rls-perf.md
--
-- Drift-tolerance: each policy is DROP POLICY IF EXISTS + CREATE (not ALTER), so a
-- prod policy that drifted (renamed/dropped via the dashboard — this project has had
-- prior policy drift) self-heals instead of hard-failing the whole db-push batch (a
-- failed migration ghost-releases the deploy: EF + Coolify steps skipped). All six
-- are PERMISSIVE FOR SELECT TO public with no WITH CHECK — reproduced verbatim below.
--
-- Deploy lock safety: the 6 policy statements on contacts (each AccessExclusive) run
-- BEFORE the CREATE INDEX / ANALYZE on eligible_properties (Share /
-- ShareUpdateExclusive), so this migration acquires its locks in the SAME order as
-- the live upsert_strata_contact_and_link RPC (contacts → eligible_properties). The
-- opposite order risks a deadlock with a concurrent MUD strata save during db push,
-- and losing that deadlock ghost-releases the deploy. `set local lock_timeout` bounds
-- any contention to a fast, re-runnable failure instead of an indefinite hang that
-- stalls prod contacts reads behind the queued AccessExclusive. Statement order is
-- otherwise correctness-neutral (all DDL commits atomically). Still: release in a
-- quiet window.
set local lock_timeout = '5s';

drop policy if exists contacts_resident_select on public.contacts;
create policy contacts_resident_select on public.contacts
as permissive for select to public
using (
  (id = (select current_user_contact_id())) and ((select current_user_role()) = 'resident'::app_role)
);

drop policy if exists contacts_client_staff_select on public.contacts;
create policy contacts_client_staff_select on public.contacts
as permissive for select to public
using (
  (select is_client_staff())
  and exists (select 1 from booking b where b.contact_id = contacts.id and b.client_id = (select current_user_client_id()))
);

drop policy if exists contacts_contractor_select on public.contacts;
create policy contacts_contractor_select on public.contacts
as permissive for select to public
using (
  ((select current_user_role()) = any (array['contractor-admin','contractor-staff']::app_role[]))
  and exists (select 1 from booking b where b.contact_id = contacts.id and b.contractor_id = (select current_user_contractor_id()))
);

-- Part B: strata rewrite. Both role-gated branches VERBATIM; accessible_client_ids()
-- stays IN (SELECT …). Uses the partial index created at the end of this migration.
drop policy if exists contacts_admin_strata_select on public.contacts;
create policy contacts_admin_strata_select on public.contacts
as permissive for select to public
using (
  ((select current_user_role()) = any (array['contractor-admin','contractor-staff','client-admin','client-staff']::app_role[]))
  and id in (
    select ep.strata_contact_id
    from eligible_properties ep
    join collection_area ca on ca.id = ep.collection_area_id
    where ep.strata_contact_id is not null
      and (
        ((select current_user_role()) = any (array['contractor-admin','contractor-staff']::app_role[]) and ca.contractor_id = (select current_user_contractor_id()))
        or ((select current_user_role()) = any (array['client-admin','client-staff']::app_role[]) and ca.client_id in (select accessible_client_ids()))
      )
  )
);

drop policy if exists contacts_staff_select_via_profiles on public.contacts;
create policy contacts_staff_select_via_profiles on public.contacts
as permissive for select to public
using (
  (((select current_user_role()) = any (array['contractor-admin','contractor-staff']::app_role[])
    and id in (select p.contact_id from profiles p join user_roles ur on ur.user_id = p.id
                where ur.is_active = true
                  and (ur.contractor_id = (select current_user_contractor_id()) or ur.client_id in (select accessible_client_ids()))))
   or ((select current_user_role()) = any (array['client-admin','client-staff']::app_role[])
    and id in (select p.contact_id from profiles p join user_roles ur on ur.user_id = p.id
                where ur.is_active = true and ur.client_id = (select current_user_client_id()))))
);

drop policy if exists contacts_ticket_staff_select on public.contacts;
create policy contacts_ticket_staff_select on public.contacts
as permissive for select to public
using (
  exists (
    select 1 from service_ticket st join client cl on cl.id = st.client_id
    where st.contact_id = contacts.id
      and (
        ((select current_user_role()) = any (array['contractor-admin','contractor-staff']::app_role[])
          and (cl.contractor_id = (select current_user_contractor_id()) or st.client_id in (select accessible_client_ids())))
        or ((select current_user_role()) = any (array['client-admin','client-staff']::app_role[])
          and st.client_id = (select current_user_client_id()))
      )
  )
);

-- Part B supporting index (created after the contacts policies to keep lock order
-- contacts → eligible_properties): leading collection_area_id serves the tenant-area
-- probe; trailing strata_contact_id makes it index-only over ~326 rows.
create index if not exists idx_ep_strata_contact_area
  on public.eligible_properties (collection_area_id, strata_contact_id)
  where strata_contact_id is not null;
analyze public.eligible_properties;  -- CREATE INDEX does not refresh stats; planner needs them to flip
