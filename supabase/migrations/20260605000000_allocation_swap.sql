-- Allocation swap (Kwinana): 3 Ancillary -> 1 free Green.
-- Two tables: allocation_conversion_rule (config, mirrors DM-Ops + a Green
-- to_service_id) and allocation_swap (applied state, one per property/FY).
-- See docs/superpowers/specs/2026-06-05-kwinana-allocation-swap-design.md

-- ── allocation_conversion_rule ──────────────────────────────────────────────
create table public.allocation_conversion_rule (
  id uuid primary key default gen_random_uuid(),
  from_allocation_rules_id uuid not null references public.allocation_rules(id) on delete cascade,
  to_allocation_rules_id   uuid not null references public.allocation_rules(id) on delete cascade,
  to_service_id            uuid not null references public.service(id),
  from_units numeric not null check (from_units > 0),
  to_units   numeric not null check (to_units > 0),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.allocation_conversion_rule is
  'Resident allocation swap config (e.g. 3 Ancillary -> 1 Green). Mirrors DM-Ops; to_service_id pins the Green target.';

alter table public.allocation_conversion_rule enable row level security;

-- Public SELECT: the /book flow is unauthenticated, like allocation_rules/service_rules.
create policy allocation_conversion_rule_public_select
  on public.allocation_conversion_rule for select using (true);

-- Writes: contractor-admin only (no admin UI in v1; seeded below).
create policy allocation_conversion_rule_admin_write
  on public.allocation_conversion_rule for all
  using (current_user_role() in ('contractor-admin'))
  with check (current_user_role() in ('contractor-admin'));

-- ── allocation_swap ─────────────────────────────────────────────────────────
create table public.allocation_swap (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.eligible_properties(id) on delete cascade,
  fy_id uuid not null references public.financial_year(id),
  collection_area_id uuid not null references public.collection_area(id),
  allocation_conversion_rule_id uuid not null references public.allocation_conversion_rule(id),
  booking_id uuid not null references public.booking(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (property_id, fy_id)
);
comment on table public.allocation_swap is
  'Applied allocation swap. One active swap per property per FY. Reverts (row deleted) when the triggering booking is cancelled.';

alter table public.allocation_swap enable row level security;

-- Resident/staff see swaps for bookings their booking RLS already lets them see.
create policy allocation_swap_owner_select
  on public.allocation_swap for select
  using (booking_id in (select id from public.booking));

-- Inserts are EF-only (service role bypasses RLS). No client insert policy.

-- ── revert-on-cancel ────────────────────────────────────────────────────────
-- When the triggering booking is cancelled, drop the swap (restores Ancillary).
create or replace function public.revert_allocation_swap_on_cancel()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'Cancelled' and old.status is distinct from 'Cancelled' then
    delete from public.allocation_swap where booking_id = new.id;
  end if;
  return new;
end;
$$;

create trigger trg_revert_allocation_swap_on_cancel
  after update of status on public.booking
  for each row execute function public.revert_allocation_swap_on_cancel();

-- ── seed: 4 Kwinana areas, Ancillary(3) -> Bulk(1), Green target ─────────────
-- ID-free: resolves by category code / service name / area code so it survives
-- environments with different UUIDs.
insert into public.allocation_conversion_rule
  (from_allocation_rules_id, to_allocation_rules_id, to_service_id, from_units, to_units)
select anc_rule.id, bulk_rule.id, green.id, 3, 1
from public.collection_area ca
join public.allocation_rules anc_rule on anc_rule.collection_area_id = ca.id
join public.category anc_cat on anc_cat.id = anc_rule.category_id and anc_cat.code = 'anc'
join public.allocation_rules bulk_rule on bulk_rule.collection_area_id = ca.id
join public.category bulk_cat on bulk_cat.id = bulk_rule.category_id and bulk_cat.code = 'bulk'
join public.service green on green.category_id = bulk_cat.id and green.name = 'Green'
where ca.client_id = (select id from public.client where slug = 'kwn')
  and ca.code in ('KWN-1','KWN-2','KWN-3','KWN-4');
