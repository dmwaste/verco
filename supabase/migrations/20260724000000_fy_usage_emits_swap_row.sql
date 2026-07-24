-- Emit the property's applied allocation swap from get_property_fy_usage.
--
-- Design (2026-06-05 allocation-swap §2/§4.2): once a property swaps its
-- Ancillary allocation for an extra Green, that forfeiture applies for the
-- REST of the FY and must be "read by the pricing data-loaders the same way
-- FY usage is". The implementation only applied the conversion inside the
-- booking that ticked the swap, so on every SUBSEQUENT booking the forfeited
-- Ancillary reappeared as free (over-grant: up to 3 free collections) and the
-- swap-granted 3rd Green was charged (over-charge). Both symptoms confirmed in
-- prod on 19 McNairn Cross, Leda + 41 Shipwright Ave, Wellard (23/07/2026).
--
-- Fix: emit a third row kind from the RPC every pricing loader already calls:
--   ('swap', <allocation_conversion_rule_id>, 1)
-- Existing consumers filter on usage_kind IN ('service','category'), so the
-- new row is invisible until a consumer opts in. Signature is unchanged, so
-- generated TS types are byte-identical (no Types-Freshness PR split).
--
-- p_exclude_booking_id also suppresses the swap row when the swap was
-- triggered BY the excluded booking: an edit of the swap-origin booking must
-- be governed solely by the explicit `swap` flag (the EF's edit path deletes /
-- re-upserts the row), not by the row it is about to reconcile.
--
-- Body identical to 20260717022050 except the third UNION branch.
-- (CREATE OR REPLACE keeps existing grants; SECURITY DEFINER + the search_path
-- pin are re-declared per repo convention.)

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
      and b.status not in ('Cancelled', 'Pending Payment', 'Rebooked')
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
  group by cat.code
  union all
  -- Applied allocation swap (at most one per property/FY — unique constraint).
  -- usage_key carries the conversion-rule id so consumers can resolve the
  -- from/to categories and units from the public-SELECT
  -- allocation_conversion_rule table. Suppressed when the swap's own booking
  -- is excluded (edit-of-swap-origin: the explicit swap flag governs).
  select 'swap'::text, sw.allocation_conversion_rule_id::text, 1::numeric
  from public.allocation_swap sw
  where sw.property_id = p_property_id
    and sw.fy_id = (select id from fy)
    and (p_exclude_booking_id is null or sw.booking_id <> p_exclude_booking_id);
$$;

comment on function public.get_property_fy_usage(uuid, uuid, uuid) is
  'PII-free FY-usage counts (SUM(no_services)) per service_id and per category code for a property, plus a (''swap'', <conversion_rule_id>, 1) row when the property has an applied allocation swap this FY (suppressed when the swap''s own booking is excluded). Used by the /book wizard preview, the confirm-page breakdown, the address-lookup allocation panel, and the create-booking price re-validation so allocation is enforced identically regardless of caller identity (the services step runs pre-OTP as anon). Excludes Cancelled, Pending Payment and Rebooked (a rebook clone replaces its original 1:1). SECURITY DEFINER because booking/booking_item/allocation_swap are RLS-scoped; returns only aggregate counts and rule ids, never PII. Anon EXECUTE is intentional (public /book flow).';

grant execute on function public.get_property_fy_usage(uuid, uuid, uuid) to anon, authenticated;
