-- Authoritative, PII-free FY-usage counts for the booking flow.
--
-- Why this exists
-- ----------------
-- The /book wizard's services step, the confirm-page breakdown, and the
-- create-booking price re-validation all count a property's prior FY usage by
-- reading booking / booking_item. Those tables are RLS-scoped to the resident's
-- own identity, but the services step runs BEFORE the OTP step — so the resident
-- is anonymous and RLS returns zero rows. Result: a returning resident sees full
-- allocation ("2 of 2 available") even after booking, and free-vs-paid pricing
-- can under-count (a resident who books under a second email, or whose prior
-- booking was created by admin-on-behalf under another contact, gets free units
-- they have already consumed).
--
-- This SECURITY DEFINER function returns ONLY aggregate counts (SUM(no_services)
-- per service_id and per category code) — never any contact/PII — so it is safe
-- to expose to the anonymous /book flow. It bypasses RLS on booking/booking_item
-- by running as the owner, giving every layer the same authoritative usage
-- regardless of who is looking. Semantics match the pricing engine exactly:
-- exclude Cancelled + Pending Payment; optionally exclude one booking (the
-- "Edit services" replace flow re-prices as a replacement, not an addition).
-- Computing the category total in SQL (join service -> category over ALL prior
-- items) also fixes a latent bug in the EF engine, which previously mapped
-- category usage only for services present in the current cart.
create or replace function public.get_property_fy_usage(
  p_property_id uuid,
  p_fy_id uuid default null,
  p_exclude_booking_id uuid default null
)
returns table (usage_kind text, usage_key text, units numeric)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with fy as (
    select coalesce(p_fy_id, (select id from public.financial_year where is_current)) as id
  ),
  items as (
    select bi.service_id, bi.no_services
    from public.booking_item bi
    join public.booking b on b.id = bi.booking_id
    where b.property_id = p_property_id
      and b.fy_id = (select id from fy)
      and b.status not in ('Cancelled', 'Pending Payment')
      and (p_exclude_booking_id is null or bi.booking_id <> p_exclude_booking_id)
  )
  -- Per-service usage
  select 'service'::text, i.service_id::text, sum(i.no_services)::numeric
  from items i
  group by i.service_id
  union all
  -- Per-category usage (over ALL prior items, not just cart services)
  select 'category'::text, cat.code, sum(i.no_services)::numeric
  from items i
  join public.service s on s.id = i.service_id
  join public.category cat on cat.id = s.category_id
  group by cat.code;
$$;

comment on function public.get_property_fy_usage(uuid, uuid, uuid) is
  'PII-free FY-usage counts (SUM(no_services)) per service_id and per category code for a property. Used by the /book wizard preview, the confirm-page breakdown, and the create-booking price re-validation so allocation is enforced identically regardless of caller identity (the services step runs pre-OTP as anon). SECURITY DEFINER because booking/booking_item are RLS-scoped to the resident; returns only aggregate counts, never PII. Anon EXECUTE is intentional (public /book flow).';

-- Anon-callable by design (public /book). Default PUBLIC EXECUTE is what we want;
-- make it explicit rather than relying on the implicit grant.
grant execute on function public.get_property_fy_usage(uuid, uuid, uuid) to anon, authenticated;
