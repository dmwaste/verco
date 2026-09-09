-- PII-free FY booking history for the /book address panel (#582, BR-0037).
--
-- Why this exists
-- ----------------
-- The address-lookup panel on /book shows two things about the property the
-- resident just typed in: an allocation tile ("1 of 3 included used") and a
-- Booking history list for the current financial year. The tile reads usage
-- through get_property_fy_usage (SECURITY DEFINER, identity-independent). The
-- history list read the `booking` table DIRECTLY. Every SELECT policy on
-- `booking` requires an authenticated identity (resident/strata by contact,
-- staff/field by tenant), and the /book flow runs pre-OTP as anon, so that
-- read returned ZERO rows: the panel said "No bookings yet for this financial
-- year" directly under a tile reporting real usage. Verified on prod as the
-- anon role (property with 5 live FY bookings: direct read 0 rows, RPC 5 units).
--
-- A signed-in resident hit a softer form of the same bug: booking_resident_select
-- is scoped by contact, so a new occupant (or a household member booking under
-- a different email) saw only THEIR bookings while the allocation is per PROPERTY.
--
-- This SECURITY DEFINER function returns ONLY ref, status and created_at —
-- never contact_id, names, email or mobile — so it is safe to expose to the
-- anonymous /book flow. A ref on its own unlocks nothing: /booking/[ref] reads
-- through the caller's RLS. Hard-capped at 5 rows (the panel shows at most 5)
-- so the function cannot be used to bulk-enumerate a property's bookings.
-- Same shape and rationale as get_property_fy_usage / get_property_allocation_overrides.
--
-- Status exclusions mirror the query this replaces (Cancelled, Pending Payment):
-- a Rebooked original stays visible as history even though get_property_fy_usage
-- does not count it (its rebook clone replaces it 1:1 for allocation).
--
-- Dormant on landing: no code calls it yet. The consumer (address-form.tsx) is
-- wired in the follow-up PR once this migration has reached prod, so the
-- Types-Freshness gate stays green (§21 PR-A / PR-B split).
create or replace function public.get_property_fy_booking_history(
  p_property_id uuid,
  p_fy_id uuid default null
)
returns table (ref text, status booking_status, created_at timestamptz)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with fy as (
    select coalesce(p_fy_id, (select id from public.financial_year where is_current)) as id
  )
  select b.ref, b.status, b.created_at
  from public.booking b
  where b.property_id = p_property_id
    and b.fy_id = (select id from fy)
    and b.status not in ('Cancelled', 'Pending Payment')
  order by b.created_at desc
  limit 5;
$$;

comment on function public.get_property_fy_booking_history(uuid, uuid) is
  'PII-free booking history (ref, status, created_at; newest 5) for a property in a financial year (p_fy_id omitted = current FY). Used by the /book address-lookup panel so the Booking history list agrees with the allocation tile regardless of caller identity — the panel renders pre-OTP as anon, for whom every booking SELECT policy returns zero rows. Excludes Cancelled and Pending Payment. SECURITY DEFINER because booking is RLS-scoped; returns no contact fields. Anon EXECUTE is intentional (public /book flow).';

-- Anon-callable by design (public /book). Default PUBLIC EXECUTE is what we want;
-- make it explicit rather than relying on the implicit grant.
grant execute on function public.get_property_fy_booking_history(uuid, uuid) to anon, authenticated;
