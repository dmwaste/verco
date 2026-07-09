-- Fix: collection_stop_select RLS timeout on the field run sheets.
--
-- Root cause (measured under a real field JWT on prod, 483 stops):
--   BEFORE  866 ms  — the `booking_id IN (SELECT id FROM booking)` subquery
--                     seq-scans all bookings and re-runs booking's OWN RLS per
--                     row (806 ms of the 866 ms lived in that one SubPlan).
--   AFTER   5.6 ms  — identical 101-row result for the field user.
--
-- Rewrite (Fix B) gates on the indexed, denormalized collection_stop.client_id
-- (the same idiom the sibling collection_stop_field_update policy already uses),
-- InitPlan-wraps the role helpers so they evaluate once, and NULL-guards the
-- sub-client helper so the field/contractor path makes zero per-row DEFINER
-- calls. Semantically equivalent to the old booking-transitive gate for every
-- role while collection_stop.client_id = booking.client_id (enforced below).
--
-- Plan + review: docs/superpowers/plans/2026-07-09-collection-stop-rls-timeout.md

alter policy collection_stop_select on public.collection_stop
using (
  (client_id in (select accessible_client_ids()))
  and ((select is_field_user()) or (select is_client_staff()) or (select is_contractor_user()))
  and ((select current_user_sub_client_id()) is null or user_sub_client_allows_booking(booking_id))
);

-- Fix B moves the SELECT trust boundary from "can you see the booking" to the
-- denormalized collection_stop.client_id. Enforce the invariant it now depends
-- on at write time, so a future service-role write or refactor can't silently
-- mint a cross-tenant-readable stop. (The app write paths already set it
-- correctly and pin it immutable; this is defence-in-depth for the read path.)
create or replace function enforce_stop_client_id_matches_booking()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking_client_id uuid;
begin
  select client_id into v_booking_client_id from booking where id = new.booking_id;
  if new.client_id is distinct from v_booking_client_id then
    raise exception
      'collection_stop.client_id (%) must equal parent booking.client_id (%) for booking %',
      new.client_id, v_booking_client_id, new.booking_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Trigger functions run as the table owner regardless of EXECUTE grants, so
-- revoking PUBLIC is safe hygiene (it is not a callable /rpc endpoint).
revoke execute on function enforce_stop_client_id_matches_booking() from public;

drop trigger if exists trg_enforce_stop_client_id on public.collection_stop;
create trigger trg_enforce_stop_client_id
  before insert or update of client_id, booking_id on public.collection_stop
  for each row execute function enforce_stop_client_id_matches_booking();
