-- Authoritative, PII-free per-service allocation-override totals for the booking flow.
--
-- Why this exists
-- ----------------
-- allocation_override lets an admin top up a single property's free allocation
-- for a financial year (e.g. City of Kwinana granting a rollover so a resident
-- whose July collection consumed their fresh FY allocation can still book). The
-- authoritative pricing engine (pricing.ts / calculate.ts) already treats
-- effective_max = base_max + SUM(extra_allocations), BUT every resident-facing
-- pricing read runs as anon (the /book services step is pre-OTP) or as the
-- `resident` role (confirm page + create-booking's price re-validation via the
-- caller-scoped anon client). allocation_override's SELECT policy is restricted
-- to authenticated STAFF roles (contractor-*/client-*), so those reads return
-- ZERO rows -> the wizard shows "0 of N remaining", the confirm page prices the
-- granted units as paid extras, and create-booking would CHARGE the resident for
-- units their council granted free. The feature only worked for admin-on-behalf.
--
-- This SECURITY DEFINER function returns ONLY aggregate counts (service_id +
-- SUM(extra_allocations)) -- never `reason` (a staff-authored internal note) or
-- `created_by` -- so it is safe to expose to the anonymous /book flow. It
-- bypasses RLS on allocation_override by running as the owner, giving every
-- layer the same authoritative override totals regardless of who is looking.
-- Same shape and rationale as get_property_fy_usage (the companion FY-usage RPC).
--
-- Dormant on landing: no code calls it yet. The consumers (pricing.ts EF, the
-- /book services + confirm previews) are wired in the follow-up PR once this
-- migration has reached prod, so the Types-Freshness gate stays green.
create or replace function public.get_property_allocation_overrides(
  p_property_id uuid,
  p_fy_id uuid default null
)
returns table (service_id uuid, extra_allocations numeric)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with fy as (
    select coalesce(p_fy_id, (select id from public.financial_year where is_current)) as id
  )
  select ao.service_id, sum(ao.extra_allocations)::numeric
  from public.allocation_override ao
  where ao.property_id = p_property_id
    and ao.fy_id = (select id from fy)
  group by ao.service_id;
$$;

comment on function public.get_property_allocation_overrides(uuid, uuid) is
  'PII-free per-service allocation-override totals (SUM(extra_allocations)) for a property + FY. Used by the /book wizard preview, the confirm-page breakdown, and the create-booking price re-validation so admin-granted allocation top-ups are honoured identically regardless of caller identity (the resident pricing path reads as anon/resident, for whom allocation_override RLS returns zero). SECURITY DEFINER because allocation_override is RLS-scoped to staff; returns only service_id + summed extra_allocations, never the staff-authored reason or created_by. Anon EXECUTE is intentional (public /book flow).';

-- Anon-callable by design (public /book). Default PUBLIC EXECUTE is what we want;
-- make it explicit rather than relying on the implicit grant.
grant execute on function public.get_property_allocation_overrides(uuid, uuid) to anon, authenticated;
