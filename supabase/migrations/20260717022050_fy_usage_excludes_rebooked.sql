-- Exclude 'Rebooked' bookings from FY allocation usage.
--
-- An NCN/NP rebook clones the original booking's items onto a new booking and
-- moves the original to status 'Rebooked' (terminal). get_property_fy_usage
-- excluded only Cancelled + Pending Payment, so after a rebook BOTH the
-- original and the clone counted — double-consuming the property's FY
-- allocation. The resident's next booking then showed fewer free units than
-- their entitlement and priced them as paid. The clone replaces the original
-- 1:1 (same items, same property, same FY), so the original must stop
-- counting the moment it is Rebooked.
--
-- Body identical to 20260710020000 except the status exclusion list.
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
  group by cat.code;
$$;

comment on function public.get_property_fy_usage(uuid, uuid, uuid) is
  'PII-free FY-usage counts (SUM(no_services)) per service_id and per category code for a property. Used by the /book wizard preview, the confirm-page breakdown, and the create-booking price re-validation so allocation is enforced identically regardless of caller identity (the services step runs pre-OTP as anon). Excludes Cancelled, Pending Payment and Rebooked (a rebook clone replaces its original 1:1). SECURITY DEFINER because booking/booking_item are RLS-scoped to the resident; returns only aggregate counts, never PII. Anon EXECUTE is intentional (public /book flow).';

grant execute on function public.get_property_fy_usage(uuid, uuid, uuid) to anon, authenticated;
