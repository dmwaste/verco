-- DM-Ops collections feed — read-only export from Verco (dmwaste/dmops Insights redesign, PR 0).
-- Plan: ~/obsidian/Claude/wiki/plans/2026-10-13-dmops-insights-redesign-plan.md §7
--
-- DM-Ops pulls these two views over postgres_fdw (hourly 06:00–20:00 AWST, nightly 120 days,
-- monthly two FYs) into its own tables. Nothing in DM-Ops reads Verco live.
--
--   dmops_export.collection_daily_v1  attended units per day × job × area × council × OptimoRoute run
--                                      × service bucket × is_extra
--   dmops_export.stop_daily_v1        stop close-out counts per day × job × area × run (DM-Ops uses them
--                                      to work out how far the collections are complete: the "horizon")
--
-- Counting rules are copied from get_client_monthly_report (20260825060000) so Insights, QSE and the
-- invoice statement tie by construction:
--   * booked units = coalesce(actual_services, no_services) on bookings that are Completed,
--     Non-conformance or Nothing Presented, not soft-deleted, bucketed by the ITEM's collection date;
--   * is_mattress items are excluded for tenants with mattress_closeout_stream set, and the
--     crew-logged collection_stop.mattress_count is counted instead, on the STOP's status and date.
-- Verified read-only on prod 13/10/2026: Jul/Aug/Sep 2026 totals match the DM-Ops snapshot exactly
-- (KWN-V 1,854 / 1,702 / 1,558; VV 2,914 / 2,517 / 2,707, same day × area counts).
--
-- Run attribution: an item's run is the driver_serial of its own stop (same booking, date and
-- stream; stops are unique on that key). Legacy backfill bookings have no stops, so they report
-- run '(unattributed)'.
--
-- Security:
--   * The schema is NOT exposed through PostgREST, and anon / authenticated / service_role get nothing.
--   * The views are owner-rights (postgres owns the base tables, RLS not forced), so dmops_reader
--     never touches a base table. Columns are counts and codes only — no resident PII.
--   * dmops_reader is created NOLOGIN. Dan enables it after this is deployed, with a SCRAM verifier
--     (never a plaintext password, never in git):
--       alter role dmops_reader with login password 'SCRAM-SHA-256$4096:...';
--     The verifier comes from dmwaste/dmops scripts/verco_reader_password.py.
--
-- NOTE: Verco migrations are applied to production by deploy.yml on the next develop → main
-- release. This file only adds a schema, two views and an inert role; it changes no existing object.

create schema if not exists dmops_export;
revoke all on schema dmops_export from public, anon, authenticated, service_role;

create or replace view dmops_export.collection_daily_v1 as
with item_units as (
  select cd.date                                                   as service_date,
         case c.slug when 'vergevalet' then 'VV' when 'kwn' then 'KWN-V' end as dm_job,
         regexp_replace(ca.code, '^KWN-', '')                      as dm_area,
         sc.name                                                   as council,
         coalesce(cs.driver_serial, '(unattributed)')              as run,
         case s.name
           when 'Bulk Waste'      then 'general'
           when 'Green Waste'     then 'green'
           when 'Mattress'        then 'mattress'
           when 'E-Waste'         then 'e_waste'
           when 'Whitegoods'      then 'whitegoods'
           when 'Illegal Dumping' then 'illegal_dumping'
           else 'unmapped:' || s.name   -- DM-Ops refuses the whole refresh on any unmapped bucket
         end                                                       as service_bucket,
         bi.is_extra,
         coalesce(bi.actual_services, bi.no_services)              as units
    from public.booking_item bi
    join public.booking b          on b.id  = bi.booking_id
    join public.client c           on c.id  = b.client_id
    join public.collection_area ca on ca.id = b.collection_area_id
    left join public.sub_client sc on sc.id = ca.sub_client_id
    join public.service s          on s.id  = bi.service_id
    join public.collection_date cd on cd.id = bi.collection_date_id
    left join public.collection_stop cs
           on cs.booking_id = bi.booking_id
          and cs.collection_date_id = bi.collection_date_id
          and cs.stream = s.waste_stream
   where c.slug in ('vergevalet', 'kwn')
     and b.deleted_at is null
     and b.status in ('Completed', 'Non-conformance', 'Nothing Presented')
     and not (s.is_mattress and c.mattress_closeout_stream is not null)
), stop_mattress as (
  select cd.date,
         case c.slug when 'vergevalet' then 'VV' when 'kwn' then 'KWN-V' end,
         regexp_replace(ca.code, '^KWN-', ''),
         sc.name,
         coalesce(cs.driver_serial, '(unattributed)'),
         'mattress',
         false,
         cs.mattress_count
    from public.collection_stop cs
    join public.client c           on c.id  = cs.client_id
    join public.booking b          on b.id  = cs.booking_id
    join public.collection_area ca on ca.id = b.collection_area_id
    left join public.sub_client sc on sc.id = ca.sub_client_id
    join public.collection_date cd on cd.id = cs.collection_date_id
   where c.slug in ('vergevalet', 'kwn')
     and c.mattress_closeout_stream is not null
     and cs.mattress_count is not null
     and b.deleted_at is null
     and cs.status in ('Completed', 'Non-conformance', 'Nothing Presented')
)
select service_date, dm_job, dm_area, council, run, service_bucket, is_extra,
       sum(units)::bigint as units
  from (select * from item_units union all select * from stop_mattress) u
 group by service_date, dm_job, dm_area, council, run, service_bucket, is_extra;

comment on view dmops_export.collection_daily_v1 is
  'DM-Ops feed: attended units per day × job × area × council × run × service bucket × is_extra (get_client_monthly_report rules). Read by dmops_reader over postgres_fdw only.';

create or replace view dmops_export.stop_daily_v1 as
select cd.date                                                      as service_date,
       case c.slug when 'vergevalet' then 'VV' when 'kwn' then 'KWN-V' end as dm_job,
       regexp_replace(ca.code, '^KWN-', '')                         as dm_area,
       coalesce(cs.driver_serial, '(unattributed)')                 as run,
       count(*) filter (where cs.status <> 'Cancelled')::bigint     as stops_total,
       count(*) filter (where cs.status in ('Completed', 'Non-conformance', 'Nothing Presented'))::bigint as stops_closed,
       count(*) filter (where cs.status = 'Pending')::bigint        as stops_open,
       max(cs.completed_at)                                         as max_closed_at
  from public.collection_stop cs
  join public.client c           on c.id  = cs.client_id
  join public.booking b          on b.id  = cs.booking_id
  join public.collection_area ca on ca.id = b.collection_area_id
  join public.collection_date cd on cd.id = cs.collection_date_id
 where c.slug in ('vergevalet', 'kwn')
   and b.deleted_at is null
   and cs.external_deleted_at is null
 group by 1, 2, 3, 4;

comment on view dmops_export.stop_daily_v1 is
  'DM-Ops feed: OptimoRoute stop close-out counts per day × job × area × run, for the collections horizon. Read by dmops_reader over postgres_fdw only.';

-- Reader role: inert until Dan sets a SCRAM password and LOGIN (see header).
do $$ begin
  create role dmops_reader nologin noinherit nobypassrls connection limit 2;
exception when duplicate_object then null;
end $$;
alter role dmops_reader set statement_timeout = '60s';

revoke all on all tables in schema dmops_export from public, anon, authenticated, service_role;
grant usage on schema dmops_export to dmops_reader;
grant select on dmops_export.collection_daily_v1, dmops_export.stop_daily_v1 to dmops_reader;
