-- Property lookups for the public /book flow that don't need a readable
-- register (29/10/2026 SECURITY DEFINER review, fix B step 1 of 3) + fix C.
--
-- Why this exists
-- ----------------
-- eligible_properties carries two SELECT policies, and between them the whole
-- property register is readable by people who should see none of it:
--
--   * eligible_properties_public_select passes every row whenever
--     current_user_sub_client_id() IS NULL — always true for an anonymous
--     caller and for every resident. Run as the anon role on prod (29/10/2026)
--     the table returned all ~110k rows across both clients, every column:
--     free-text location notes (some with emails or gate codes), MUD form
--     storage paths, strata contact ids. The anon key ships in the browser
--     bundle, so anyone could page through it.
--   * eligible_properties_select passes a caller's whole client whenever their
--     user_roles row carries a client_id — staff, but also ~1,300 residents.
--
-- The public flow only ever asks two narrow questions:
--   1. "which property is at this address?" — address-form.tsx, at most 5
--      candidate rows, 13 columns  → lookup_eligible_properties()
--   2. "what are this property's booking facts?" — calculate-price and
--      create-booking, by id       → get_property_for_booking()
-- Both become SECURITY DEFINER functions here so the table itself can stop
-- being public.
--
-- Three steps, one per release, so /book never breaks mid-deploy (migrations
-- run before the app and Edge Functions roll out):
--   1. THIS migration — the functions, dormant (no caller yet). Lands first so
--      the Types-Freshness gate stays green (§21 PR-A / PR-B split).
--   2. app + Edge Functions call them instead of reading the table.
--   3. the two policies close: staff by tenant, residents/strata only the
--      properties on their own bookings (current_user_property_ids(), landed
--      here so step 3 is a policy-only change).
--
-- Fix C (same review): four trigger functions were EXECUTE-able by anon and
-- authenticated over /rpc. Triggers never check the caller's EXECUTE (it's
-- checked when the trigger is created), so revoking it changes nothing about
-- how they fire. Same pattern as contact_view_log_skip_repeat (20261021085854).

-- ── 1. Address lookup for /book ──────────────────────────────────────────────
-- Mirrors the two direct reads it replaces in address-form.tsx:
--   * p_place_id set   → exact google_place_id match (the primary path)
--   * p_place_id null  → PREFIX match (VER-214: never a contains) of
--                        p_formatted_key on formatted_address OR p_address_key
--                        on address. The caller passes the KEY, not a pattern:
--                        LIKE metacharacters are escaped here, so a caller
--                        can't widen the match with its own % or _. Keys under
--                        6 characters match nothing (no stored street segment
--                        is that short, prod 29/10/2026).
-- Tenant-pinned to p_client_id, earliest row first (duplicate imports resolve
-- deterministically), hard-capped at 5 rows so the function can't be used to
-- dump the register. Sub-client narrowing carried over from the policies it
-- replaces (ADR 0019): a sub-client-scoped staff member booking on a
-- resident's behalf still finds only their own council's properties.
create or replace function public.lookup_eligible_properties(
  p_client_id uuid,
  p_place_id text default null,
  p_formatted_key text default null,
  p_address_key text default null
)
returns table (
  id uuid,
  address text,
  formatted_address text,
  google_place_id text,
  has_geocode boolean,
  is_eligible boolean,
  is_mud boolean,
  latitude numeric,
  longitude numeric,
  collection_area_id uuid,
  created_at timestamptz,
  area_client_id uuid,
  area_is_active boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with k as (
    select
      nullif(btrim(p_place_id), '') as place_id,
      case when length(btrim(p_formatted_key)) >= 6 then
        replace(replace(replace(btrim(p_formatted_key), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      end as fmt_pattern,
      case when length(btrim(p_address_key)) >= 6 then
        replace(replace(replace(btrim(p_address_key), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      end as addr_pattern
  )
  select
    ep.id, ep.address, ep.formatted_address, ep.google_place_id, ep.has_geocode,
    ep.is_eligible, ep.is_mud, ep.latitude, ep.longitude, ep.collection_area_id,
    ep.created_at, ca.client_id, ca.is_active
  from public.eligible_properties ep
  join public.collection_area ca on ca.id = ep.collection_area_id
  cross join k
  where ca.client_id = p_client_id
    and (
      (k.place_id is not null and ep.google_place_id = k.place_id)
      or (
        k.place_id is null
        and (ep.formatted_address ilike k.fmt_pattern or ep.address ilike k.addr_pattern)
      )
    )
    and (
      (select public.current_user_sub_client_id()) is null
      or ca.sub_client_id = (select public.current_user_sub_client_id())
    )
  order by ep.created_at
  limit 5;
$$;

comment on function public.lookup_eligible_properties(uuid, text, text, text) is
  'Address lookup for the public /book flow: at most 5 properties of one client matching a Google place_id, or an address key as a prefix (LIKE metacharacters escaped server-side; keys under 6 chars match nothing). Returns only the 13 columns /book renders — never notes, MUD form paths, strata contacts or unit counts. SECURITY DEFINER so eligible_properties can be closed to anon and residents (29/10/2026 review). Anon EXECUTE is intentional.';

grant execute on function public.lookup_eligible_properties(uuid, text, text, text) to anon, authenticated;

-- ── 2. Booking facts by id, for calculate-price + create-booking ────────────
-- Both Edge Functions read the property through the CALLER's JWT (anon
-- pre-OTP, the resident post-OTP), so they lose the row once step 3 closes the
-- table. Property ids are unguessable UUIDs and come back from the lookup
-- above; the five columns are structural, no PII. Same sub-client narrowing.
create or replace function public.get_property_for_booking(p_property_id uuid)
returns table (
  id uuid,
  collection_area_id uuid,
  is_mud boolean,
  unit_count integer,
  is_eligible boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ep.id, ep.collection_area_id, ep.is_mud, ep.unit_count, ep.is_eligible
  from public.eligible_properties ep
  left join public.collection_area ca on ca.id = ep.collection_area_id
  where ep.id = p_property_id
    and (
      (select public.current_user_sub_client_id()) is null
      or ca.sub_client_id = (select public.current_user_sub_client_id())
    );
$$;

comment on function public.get_property_for_booking(uuid) is
  'Booking facts (area, MUD flag, unit count, eligibility) for one property by id. Used by calculate-price and create-booking, which run as the anonymous or resident caller and so cannot read eligible_properties directly once it is closed (29/10/2026 review). No PII. Anon EXECUTE is intentional.';

grant execute on function public.get_property_for_booking(uuid) to anon, authenticated;

-- ── 3. Properties on the caller's own bookings (step-3 resident branch) ─────
-- The resident pages (/dashboard, /booking/[ref], /contact/tickets/[id]) embed
-- eligible_properties through the booking. Once the table closes, a resident
-- may read exactly the properties of the bookings booking_resident_select
-- already shows them (same contact match, same roles), plus a strata user's
-- authorised MUD properties. SETOF so the policy can use
-- `id IN (SELECT current_user_property_ids())` — hoisted to one InitPlan per
-- statement, never per row (verco-rls-initplan-timeout). Only the step-3
-- policy (TO authenticated) calls it, so anon EXECUTE is revoked.
create or replace function public.current_user_property_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select b.property_id
  from public.booking b
  where b.property_id is not null
    and (select public.current_user_role()) in ('resident', 'strata')
    and (
      b.contact_id = (select public.current_user_contact_id())
      or b.contact_id = (select public.current_user_contact_id_by_email())
    )
  union
  select sup.property_id
  from public.strata_user_properties sup
  where sup.user_id = auth.uid()
    and (select public.current_user_role()) = 'strata';
$$;

comment on function public.current_user_property_ids() is
  'Property ids on the calling resident''s or strata user''s own bookings (the bookings booking_resident_select shows them), plus a strata user''s authorised MUD properties. Backs the resident branch of the eligible_properties SELECT policy (29/10/2026 review). Empty for staff, field and anon.';

revoke execute on function public.current_user_property_ids() from public, anon;
grant execute on function public.current_user_property_ids() to authenticated;

-- ── 4. Fix C: trigger functions are not API endpoints ───────────────────────
revoke execute on function public.enforce_stop_client_id_matches_booking() from public, anon, authenticated;
revoke execute on function public.property_note_set_client_id() from public, anon, authenticated;
revoke execute on function public.recalculate_collection_date_units() from public, anon, authenticated;
revoke execute on function public.sync_stops_on_booking_item_date() from public, anon, authenticated;
