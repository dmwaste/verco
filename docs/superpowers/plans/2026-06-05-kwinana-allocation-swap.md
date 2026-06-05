# Kwinana Allocation Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Kwinana resident swap their whole Ancillary allocation (3) for one extra free **Green** collection, via a checkbox on the services step — config-driven, re-validated server-side.

**Architecture:** Mirror DM-Ops' `allocation_conversion_rule` config table in Verco (+ a Green `to_service_id`) and add an `allocation_swap` state table (property+FY). The dual-limit pricing engine (`computeLineItems`) gains an optional `conversion` input that drops Ancillary's category max by `from_units`, raises Bulk's category max by `to_units`, and raises **Green's service max** by `to_units` (General stays 2, so Green-only enforces itself through the existing `MIN()`). The services-step checkbox feeds the client preview; `create-booking` re-validates and records the swap.

**Tech Stack:** Next.js 16 / TS strict, Supabase (Postgres + RLS + Edge Functions/Deno), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-05-kwinana-allocation-swap-design.md`

**Hard dependency:** PR [#147](https://github.com/dmwaste/verco/pull/147) (confirm-page breakdown → shared engine) must merge to `develop` first — the swap relies on the confirm breakdown coming from `computeLineItems`.

**Release sequencing (CLAUDE.md §21 — ghost-release + types-freshness):**
Migrations apply only on `deploy.yml` (`branches: [main]`), so the new tables aren't in prod-generated types until a release. The split follows that gate, refined so the non-type-gated work lands early (Beck: make the change easy, then make the easy change):
- **PR-A** = migration + seed **+ the pure engine `conversion` capability** (`calculate.ts` + EF mirror `_shared/pricing.ts`) **+ `swap.ts` eligibility helper + unit tests**. None of these import generated DB types (the EF uses an untyped `SupabaseClient`), and the engine change is dormant behind `if (conversion)`. Releases → applies migration → regen types.
- **PR-B** = the type-gated wiring (services-form refactor + checkbox, confirm display, create-booking re-validation, E2E) against the regen'd types.
A single PR fails Types Freshness CI because the new tables aren't in prod-generated types yet.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `supabase/migrations/<ts>_allocation_swap.sql` | both tables + RLS + seed + revert trigger | 1 |
| `src/lib/pricing/calculate.ts` | add `ActiveConversion` + `conversion` param to `computeLineItems` (pure) | 2 |
| `supabase/functions/_shared/pricing.ts` | **manual** mirror of the same change (NOT in sync-mirrors.sh) | 2 |
| `src/__tests__/pricing/conversion.test.ts` | engine swap unit tests | 2 |
| `src/lib/pricing/swap.ts` | shared helpers: load active conversion rule + applied swap; build `ActiveConversion` | 3 |
| `src/app/(public)/book/services/services-form.tsx` | checkbox + eligibility + preview + carry `swap` param | 4 |
| `src/lib/pricing/build-breakdown.ts` | accept optional `conversion` (confirm display) | 4 |
| `src/app/(public)/book/confirm/confirm-form.tsx` | read `swap` param, pass conversion to breakdown + EF | 4 |
| `supabase/functions/create-booking/index.ts` | accept `swap`, re-validate, insert `allocation_swap` | 5 |
| `tests/e2e/allocation-swap.spec.ts` | end-to-end resident swap flow | 6 |

> **Scope decision (eng review, D1):** DM-Ops nightly-sync of the explicit swap-state is **deferred to a fast follow** (NOT in this plan). The triggering Green booking still reaches DM-Ops via existing booking sync; only DM-Ops's *awareness of why ancillary was forfeited* waits. See "NOT in scope".

---

## Phase 1 — Migration + seed (PR-A, releases on its own)

### Task 1: Create the two tables, RLS, seed, and revert trigger

**Files:**
- Create: `supabase/migrations/<timestamp>_allocation_swap.sql` (via `pnpm supabase migration new allocation_swap`)

- [ ] **Step 1: Generate the migration file**

Run: `pnpm supabase migration new allocation_swap`
Expected: prints the new file path under `supabase/migrations/`.

- [ ] **Step 2: Write the schema + RLS + seed + trigger**

Paste into the new migration file:

```sql
-- allocation_conversion_rule: mirror of DM-Ops, + Verco-only to_service_id (Green target)
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

-- Public SELECT (the /book flow is unauthenticated, like allocation_rules/service_rules)
create policy allocation_conversion_rule_public_select
  on public.allocation_conversion_rule for select using (true);

-- Writes: contractor-admin only (no admin UI in v1; seeded here)
create policy allocation_conversion_rule_admin_write
  on public.allocation_conversion_rule for all
  using (current_user_role() in ('contractor-admin'))
  with check (current_user_role() in ('contractor-admin'));

-- allocation_swap: records a property forfeiting Ancillary for the FY
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

-- Resident sees own (booking they own); staff see their tenant scope.
create policy allocation_swap_owner_select
  on public.allocation_swap for select
  using (
    booking_id in (select id from public.booking)   -- booking RLS already scopes the resident/staff view
  );

-- Inserts are EF-only (service role bypasses RLS). No client-side insert policy.

-- Revert on cancel: when the triggering booking is cancelled, drop the swap
-- (restores Ancillary). AFTER UPDATE so booking RLS/triggers run first.
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

-- Seed: 4 Kwinana areas, Ancillary(3) -> Bulk(1), Green target. ID-free (resolves by code/name).
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
```

- [ ] **Step 3: Apply locally to validate SQL**

Run: `pnpm supabase db reset` (local stack) OR review-only if no local stack.
Expected: migration applies with no error; `select count(*) from allocation_conversion_rule;` returns `4`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(db): allocation_conversion_rule + allocation_swap tables, RLS, Kwinana seed"
```

- [ ] **Step 5: Open PR-A → develop, release, regen types**

After PR-A merges and is released to prod (verify `/api/health` SHA per ghost-release rule), regenerate types:
```bash
pnpm supabase gen types typescript --project-id tfddjmplcizfirxqhotv > src/lib/supabase/types.ts
# strip any CLI warning lines the command appends
```
Commit the regen'd types as the first commit of PR-B.

---

## Phase 2 — Pricing engine `conversion` input (PR-B)

### Task 2: Add `ActiveConversion` + apply it in `computeLineItems`

**Files:**
- Modify: `src/lib/pricing/calculate.ts`
- Test: `src/__tests__/pricing/conversion.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/pricing/conversion.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeLineItems, type ServiceRule, type ActiveConversion } from '@/lib/pricing/calculate'

const GENERAL = 'svc-general', GREEN = 'svc-green', MATTRESS = 'svc-mattress'
const BULK = 'bulk', ANC = 'anc'

const rules = (): Map<string, ServiceRule> => new Map([
  [GENERAL, { max_collections: 2, extra_unit_price: 89.67 }],
  [GREEN, { max_collections: 2, extra_unit_price: 89.67 }],
  [MATTRESS, { max_collections: 1, extra_unit_price: 45 }],
])
const catMax = (): Map<string, number> => new Map([[BULK, 2], [ANC, 3]])
const svcCat = (): Map<string, string> => new Map([[GENERAL, BULK], [GREEN, BULK], [MATTRESS, ANC]])
const conversion: ActiveConversion = {
  from_category_code: ANC, to_category_code: BULK, to_service_id: GREEN, from_units: 3, to_units: 1,
}

describe('computeLineItems with an active conversion (swap)', () => {
  it('makes a 3rd Bulk collection (Green) free', () => {
    // 2 General + 1 Green = 3 Bulk. Swap raises Bulk cat to 3 and Green svc to 3.
    const r = computeLineItems(
      [{ service_id: GENERAL, quantity: 2 }, { service_id: GREEN, quantity: 1 }],
      rules(), catMax(), svcCat(), new Map(), new Map(), undefined, 1, conversion,
    )
    expect(r.total_cents).toBe(0)
    expect(r.line_items.every((l) => l.paid_units === 0)).toBe(true)
  })

  it('does NOT let the extra Bulk slot go to General (Green-only)', () => {
    // 3 General with swap: General svc cap stays 2 → 1 paid even though Bulk cat is 3.
    const r = computeLineItems(
      [{ service_id: GENERAL, quantity: 3 }],
      rules(), catMax(), svcCat(), new Map(), new Map(), undefined, 1, conversion,
    )
    expect(r.line_items[0]!.free_units).toBe(2)
    expect(r.line_items[0]!.paid_units).toBe(1)
  })

  it('zeroes the Ancillary budget when swapped', () => {
    // 1 Mattress with swap: Ancillary cat 3 → 0 → paid.
    const r = computeLineItems(
      [{ service_id: MATTRESS, quantity: 1 }],
      rules(), catMax(), svcCat(), new Map(), new Map(), undefined, 1, conversion,
    )
    expect(r.line_items[0]!.paid_units).toBe(1)
  })

  it('no conversion = unchanged (regression)', () => {
    const r = computeLineItems(
      [{ service_id: GREEN, quantity: 1 }],
      rules(), catMax(), svcCat(), new Map(), new Map(),
    )
    expect(r.line_items[0]!.free_units).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test run src/__tests__/pricing/conversion.test.ts`
Expected: FAIL — `ActiveConversion` not exported / 9th arg ignored.

- [ ] **Step 3: Implement in `calculate.ts`**

Add the interface (near the other exports):

```ts
export interface ActiveConversion {
  from_category_code: string
  to_category_code: string
  to_service_id: string
  from_units: number
  to_units: number
}
```

Change the signature to add a 9th optional param after `unitMultiplier`:

```ts
export function computeLineItems(
  items: PricingItem[],
  rulesMap: Map<string, ServiceRule>,
  categoryMaxMap: Map<string, number>,
  serviceCategoryMap: Map<string, string>,
  serviceUsageMap: Map<string, number>,
  categoryUsageMap: Map<string, number>,
  overrides?: AllocationOverride[],
  unitMultiplier = 1,
  conversion?: ActiveConversion,
): PriceCalculationResult {
```

Immediately before `const categoryFormUsed = new Map<string, number>()`, derive effective budgets on LOCAL copies (never mutate the caller's maps). Conversion units are residential — not scaled by `unitMultiplier`:

```ts
  // Apply an active allocation swap as a budget adjustment on local copies.
  // Guard (eng review A2): the swap is residential-only — its from/to units are
  // NOT scaled by unitMultiplier, and MUD swaps are out of scope, so only apply
  // when unitMultiplier === 1. A MUD + conversion combination would mis-scale.
  const effectiveCategoryMax = new Map(categoryMaxMap)
  const serviceMaxBonus = new Map<string, number>()
  if (conversion && unitMultiplier === 1) {
    effectiveCategoryMax.set(
      conversion.from_category_code,
      Math.max(0, (effectiveCategoryMax.get(conversion.from_category_code) ?? 0) - conversion.from_units),
    )
    effectiveCategoryMax.set(
      conversion.to_category_code,
      (effectiveCategoryMax.get(conversion.to_category_code) ?? 0) + conversion.to_units,
    )
    serviceMaxBonus.set(conversion.to_service_id, conversion.to_units)
  }
```

In the per-line calc, replace the two budget reads:
- `const serviceMax = (rule?.max_collections ?? 0) * unitMultiplier` → add the bonus:
  `const serviceMax = (rule?.max_collections ?? 0) * unitMultiplier + (serviceMaxBonus.get(item.service_id) ?? 0)`
- `const catMax = (categoryMaxMap.get(catCode) ?? 0) * unitMultiplier` →
  `const catMax = (effectiveCategoryMax.get(catCode) ?? 0) * unitMultiplier`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test run src/__tests__/pricing/`
Expected: PASS (new conversion tests + existing).

- [ ] **Step 5: Mirror the change into the EF engine**

`supabase/functions/_shared/pricing.ts` is the source mirror and is **NOT** auto-synced (not in `scripts/sync-mirrors.sh`). Apply the identical `ActiveConversion` interface + `conversion` param + effective-budget logic to the pure compute function in that file, and thread a `conversion` option through the async `calculatePrice(...)` wrapper so the EF can pass it. Use Deno-style imports already present in that file.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck && pnpm test run src/__tests__/pricing/
git add src/lib/pricing/calculate.ts supabase/functions/_shared/pricing.ts src/__tests__/pricing/conversion.test.ts
git commit -m "feat(pricing): conversion input for allocation swap (Anc -> Green)"
```

---

## Phase 3 — Swap data + eligibility helpers

### Task 3: `swap.ts` — load active conversion rule + applied swap; eligibility

**Files:**
- Create: `src/lib/pricing/swap.ts`
- Test: `src/__tests__/pricing/swap.test.ts`

- [ ] **Step 1: Write the failing test** for the pure eligibility predicate:

```ts
import { describe, it, expect } from 'vitest'
import { isSwapEligible } from '@/lib/pricing/swap'

describe('isSwapEligible', () => {
  it('eligible when a rule exists, 0 ancillary used, no existing swap, no ancillary in cart', () => {
    expect(isSwapEligible({ hasRule: true, ancillaryFyUsed: 0, hasExistingSwap: false, ancillaryInCart: 0 })).toBe(true)
  })
  it('ineligible if any ancillary used this FY', () => {
    expect(isSwapEligible({ hasRule: true, ancillaryFyUsed: 1, hasExistingSwap: false, ancillaryInCart: 0 })).toBe(false)
  })
  it('ineligible if no rule, existing swap, or ancillary in cart', () => {
    expect(isSwapEligible({ hasRule: false, ancillaryFyUsed: 0, hasExistingSwap: false, ancillaryInCart: 0 })).toBe(false)
    expect(isSwapEligible({ hasRule: true, ancillaryFyUsed: 0, hasExistingSwap: true, ancillaryInCart: 0 })).toBe(false)
    expect(isSwapEligible({ hasRule: true, ancillaryFyUsed: 0, hasExistingSwap: false, ancillaryInCart: 2 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run → fail.** `pnpm test run src/__tests__/pricing/swap.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement `src/lib/pricing/swap.ts`:**

```ts
import type { ActiveConversion } from './calculate'

export interface SwapEligibilityInput {
  hasRule: boolean
  ancillaryFyUsed: number
  hasExistingSwap: boolean
  ancillaryInCart: number
}

export function isSwapEligible(i: SwapEligibilityInput): boolean {
  return i.hasRule && i.ancillaryFyUsed === 0 && !i.hasExistingSwap && i.ancillaryInCart === 0
}

/** Row shape returned by the allocation_conversion_rule query (with category codes + service joined). */
export interface ConversionRuleRow {
  id: string
  from_units: number
  to_units: number
  to_service_id: string
  from_category_code: string // 'anc'
  to_category_code: string   // 'bulk'
}

export function toActiveConversion(rule: ConversionRuleRow): ActiveConversion {
  return {
    from_category_code: rule.from_category_code,
    to_category_code: rule.to_category_code,
    to_service_id: rule.to_service_id,
    from_units: rule.from_units,
    to_units: rule.to_units,
  }
}
```

- [ ] **Step 4: Run → pass.** `pnpm test run src/__tests__/pricing/swap.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/pricing/swap.ts src/__tests__/pricing/swap.test.ts
git commit -m "feat(pricing): swap eligibility + conversion-rule mapping helpers"
```

> **Note on the conversion-rule query** (used by services-form + confirm + EF): select from `allocation_conversion_rule` filtered to the area's allocation_rules, embedding category codes:
> `from_allocation_rules:from_allocation_rules_id ( collection_area_id, category!inner(code) )` and `to_allocation_rules:to_allocation_rules_id ( category!inner(code) )`. Match `from_allocation_rules.collection_area_id == collectionAreaId`. Map to `ConversionRuleRow`. Because two FKs point at the same `allocation_rules` table, use the **explicit FK alias** form (`from_allocation_rules:from_allocation_rules_id(...)`) to avoid the multi-FK embed-returns-empty gotcha (CLAUDE.md §21 / `composite-fk-breaks-embed`).

---

## Phase 4 — Booking flow UI

### Task 4: Services-step checkbox + preview + carry param

**Files:**
- Modify: `src/app/(public)/book/services/services-form.tsx`
- Modify: `src/lib/pricing/build-breakdown.ts` (optional `conversion` passthrough)
- Modify: `src/app/(public)/book/confirm/confirm-form.tsx`

- [ ] **Step 1: services-form — fetch the active conversion rule + existing swap.** Add two `useQuery`s mirroring the existing `categoryAllocations` query: one for the area's `allocation_conversion_rule` (→ `ConversionRuleRow | null`), one for any `allocation_swap` for this `propertyId` + current FY (→ boolean `hasExistingSwap`). Reuse the `fyUsageByCategory` query for `ancillaryFyUsed = fyUsageByCategory.get('anc') ?? 0`.

- [ ] **Step 2: Add swap state + eligibility.**

```ts
const [swapApplied, setSwapApplied] = useState(searchParams.get('swap') === 'true')
const ancillaryInCart = useMemo(() =>
  serviceRules?.filter(r => r.service.category.code === 'anc')
    .reduce((n, r) => n + (quantities.get(r.service_id) ?? 0), 0) ?? 0,
  [serviceRules, quantities])
const swapEligible = isSwapEligible({
  hasRule: !!conversionRule,
  ancillaryFyUsed: fyUsageByCategory?.get('anc') ?? 0,
  hasExistingSwap,
  ancillaryInCart,
})
```

- [ ] **Step 3: Refactor the preview onto the shared engine (eng review A1).** Replace the inline dual-limit loop in the `pricingItems` `useMemo` (`services-form.tsx:187-235`) with a `computeLineItems(...)` call — the same single source the bug fix gave the confirm page. Pass `swapApplied && conversionRule ? toActiveConversion(conversionRule) : undefined` as the conversion arg. Derive `categoryFreeUsed`/`getLiveRemaining` from the returned `line_items` (sum `free_units` per category) so the badges stay correct (Ancillary → 0, Bulk → +1 when swapped). This eliminates the 4th private copy of the pricing rule — the swap conversion then lives in exactly ONE place (the engine).

- [ ] **Step 4: Render the checkbox** below the Ancillary section, only when `swapEligible || swapApplied`:

```tsx
{(swapEligible || swapApplied) && (
  <label className="flex items-start gap-2.5 rounded-xl border-[1.5px] border-gray-100 bg-white px-4 py-3.5 shadow-sm">
    <input type="checkbox" checked={swapApplied}
      onChange={(e) => {
        setSwapApplied(e.target.checked)
        if (e.target.checked) {
          // forfeit ancillary: clear any ancillary items from the cart
          setQuantities(prev => {
            const next = new Map(prev)
            serviceRules?.filter(r => r.service.category.code === 'anc')
              .forEach(r => next.delete(r.service_id))
            return next
          })
        }
      }} />
    <span className="text-body-sm text-gray-700">
      <strong>Swap my 3 ancillary collections for 1 extra green waste collection.</strong>
      {' '}You won’t be able to book e-waste, whitegoods or mattresses this year.
    </span>
  </label>
)}
```

When `swapApplied`, disable the Ancillary steppers (pass a `disabled` flag into `renderServiceSection` for the `anc` section).

- [ ] **Step 5: Carry `swap` to later steps.** In `handleContinue`, add `...(swapApplied ? { swap: 'true' } : {})` to the params.

- [ ] **Step 6: build-breakdown — accept `conversion`.** Add `conversion?: ActiveConversion` to `BreakdownInput` and pass it as the 9th arg to `computeLineItems`. confirm-form (post-#147) reads `searchParams.get('swap') === 'true'`, loads the area's conversion rule, and passes `conversion` into `buildConfirmBreakdown` + a `swap=true` flag to the create-booking request body. Add a "Ancillary swapped — 1 Green included" note in the Services block when swap is on.

- [ ] **Step 7: Manual verify + commit.** Build (`pnpm build`) and, if a dev env is available, drive services → tick swap → confirm shows the free Green and no ancillary. Commit:

```bash
git add "src/app/(public)/book/services/services-form.tsx" src/lib/pricing/build-breakdown.ts "src/app/(public)/book/confirm/confirm-form.tsx"
git commit -m "feat(book): allocation swap checkbox + preview wiring"
```

---

## Phase 5 — Server re-validation + sync

### Task 5: `create-booking` re-validate + record swap

**Files:**
- Modify: `supabase/functions/create-booking/index.ts`

- [ ] **Step 1: Accept `swap` in the request body** (Zod-validate: `swap: z.boolean().optional()`).

- [ ] **Step 2: Load + apply the conversion when `swap === true`.** Before the `calculatePrice` call (index.ts:~184), fetch the active `allocation_conversion_rule` for `collection_area_id`. Reject (`jsonResponse({ error: ... }, 400)`) if: no active rule for the area; OR Ancillary FY usage for the property ≠ 0; OR the cart contains any Ancillary item. Pass the conversion into `calculatePrice` (threaded through to the EF's compute) so pricing reflects the free Green.

- [ ] **Step 3: Insert the `allocation_swap` row** inside the same path as the booking insert (service-role client), after `create_booking_with_capacity_check` returns the `booking_id`:

```ts
if (swap) {
  await supabaseService.from('allocation_swap').insert({
    property_id, fy_id, collection_area_id,
    allocation_conversion_rule_id: conversionRule.id,
    booking_id,
  })
}
```

Use `assertRowsAffected`-style checking (a failed insert must surface, not silently no-op — CLAUDE.md cron memory). The `unique(property_id, fy_id)` guards double-swap.

- [ ] **Step 4: Handle the unique-violation gracefully.** If the `allocation_swap` insert fails on `unique(property_id, fy_id)` (a concurrent booking already swapped), return a clear 409/400 (`error: 'A swap has already been applied for this property this year.'`) — not a 500. This is the server-side backstop for the client-side eligibility race.

- [ ] **Step 5: Deploy + commit.**

```bash
pnpm supabase functions deploy create-booking --no-verify-jwt
git add supabase/functions/create-booking/index.ts
git commit -m "feat(ef): create-booking re-validates + records allocation swap"
```

> **Deferred (fast follow, not this plan):** `nightly-sync-to-dm-ops` to carry the explicit `allocation_swap` state so DM-Ops knows *why* ancillary was forfeited. The triggering Green booking already syncs via existing machinery, so this is reporting-completeness, not an ops break.

---

## Phase 6 — E2E

### Task 6: Resident swap E2E

**Files:**
- Create: `tests/e2e/allocation-swap.spec.ts`

- [ ] **Step 1: Write the E2E** (follow `tests/e2e` patterns + the authenticated-e2e-harness spec). Scenario: eligible Kwinana property → services step → tick swap → ancillary steppers disabled → add 1 Green → confirm shows "Included" (free) + the swap note → create booking → dashboard shows it. Negative: after swap, re-entering the flow shows ancillary blocked / checkbox gone (existing swap).

- [ ] **Step 2: Run.** `pnpm test:e2e tests/e2e/allocation-swap.spec.ts` → PASS.

- [ ] **Step 3: Commit + open PR-B → develop.**

```bash
git add tests/e2e/allocation-swap.spec.ts
git commit -m "test(e2e): resident allocation swap flow"
```

---

## Review additions (eng review — Sections 2 & 3)

### Edit-flow reconciliation (Code Quality — confidence 6)
The admin/resident "Edit services" flow keeps the same `booking_id` (via `?replaces=`). If someone edits a swap booking and removes the Green or unticks the swap, the `allocation_swap` row would go stale (property shows ancillary forfeited but the booking no longer reflects a swap). **Handle in Task 5:** in `create-booking`'s update branch, after re-pricing, reconcile — `delete from allocation_swap where booking_id = <id>` when the updated booking is not a swap; (re-)insert when it is. Add a unit/integration assertion for the un-swap-on-edit path.

### Test gaps to close (Test review — these are plan-required, not optional)
- **[CRITICAL — regression]** `src/__tests__/pricing/conversion.test.ts` already covers the engine swap math (Task 2). **Add** an assertion that a swap + an Ancillary item in the cart yields `paid_units > 0` for that ancillary (proves the budget really zeroed).
- **EF re-validation** (Task 5): integration tests — (a) `swap:true` with prior ancillary usage → 400; (b) `swap:true`, no active rule for area → 400; (c) happy path inserts exactly one `allocation_swap` row; (d) concurrent double-swap → 2nd returns 409, not 500 (the `unique` backstop).
- **Revert trigger** (Task 1): a DB test — insert a swap, cancel the booking, assert the `allocation_swap` row is gone; and the edit-flow un-swap above.
- **E2E** (Task 6): the existing happy-path + the post-swap "ancillary blocked / checkbox gone" negative (already in the plan).

### Coverage diagram

```
ENGINE (computeLineItems + EF mirror)
  └── conversion branch
      ├── [★★★] 2 General + 1 Green free          conversion.test.ts
      ├── [★★★] 3 General → 1 paid (Green-only)    conversion.test.ts
      ├── [★★★] ancillary zeroed → paid            conversion.test.ts (add assertion)
      └── [★★★] no conversion = unchanged          conversion.test.ts
ELIGIBILITY (isSwapEligible)                        [★★★] swap.test.ts
EF create-booking (swap path)                       [GAP→add] reject-used / reject-no-rule / insert / 409
DB revert trigger + edit un-swap                    [GAP→add] DB test
USER FLOW: tick swap → free Green → dashboard        [→E2E] allocation-swap.spec.ts
USER FLOW: post-swap ancillary blocked               [→E2E] allocation-swap.spec.ts
COVERAGE TARGET: engine 100%, EF paths + trigger covered, 2 E2E
```

## Performance review
No issues. Two small added queries (active conversion rule + existing-swap check) are per-area/per-property point lookups, no N+1, negligible. The services-form engine refactor (A1) removes a hand-rolled loop in favour of the same O(n) engine pass — net neutral.

## NOT in scope (deferred, with rationale)
- **DM-Ops nightly-sync of swap state** — Green booking already syncs; DM-Ops swap-awareness is a fast follow (D1).
- **Admin UI to edit conversion rules** — seeded by migration; admin-config later.
- **Bidirectional / partial swaps, non-Green targets** — Kwinana needs only Ancillary→Green 3→1.
- **MUD / admin-on-behalf swaps** — resident self-serve only; guarded by `unitMultiplier === 1` (A2).

## What already exists (reused, not rebuilt)
- `computeLineItems` dual-limit engine — swap is a budget delta on it, not new pricing.
- `build-breakdown.ts` (PR #147) — reused for confirm display.
- DM-Ops `allocation_conversion_rule` — mirrored, not reinvented.
- `allocation_override` hook — deliberately NOT reused (additive-only; a swap needs −from & +to).

## Failure modes
| Codepath | Failure | Test? | Handled? | User sees |
|---|---|---|---|---|
| EF swap re-validation | client sends swap but ancillary already used | yes (add) | 400 reject | clear error |
| concurrent double-swap | 2 bookings race the eligibility check | yes (add) | `unique` → 409 | clear error |
| edit removes Green | stale `allocation_swap` row | yes (add) | reconcile-on-edit | correct allocation |
| cancel swap booking | ancillary not restored | yes (add) | revert trigger | ancillary back |

No critical (untested AND unhandled AND silent) gaps after the additions above.

## Out of scope (v1)
Admin UI to edit conversion rules; bidirectional/partial swaps; non-Green targets; MUD / admin-on-behalf swaps; DM-Ops swap-state sync. (Spec §9 + D1.)

## Testing summary
- Pricing engine 100% incl. all swap permutations (Task 2) — Node + EF mirror identical.
- Eligibility predicate unit-tested (Task 3).
- EF re-validation + revert/edit reconciliation tested (Task 5 / Task 1).
- E2E swap happy-path + post-swap block (Task 6).
- RLS smoke: `allocation_conversion_rule` public-SELECT; `allocation_swap` owner/staff/EF-insert.

## Parallelization
PR-A (migration) must land + release before any PR-B work. Within PR-B, the
dependency graph is mostly sequential because the type flows downhill:

```
Task 2 (engine + ActiveConversion type)
   ├──> Task 3 (swap.ts — imports ActiveConversion)
   │       └──> Task 4 (services-form + confirm — use helpers)
   └──> Task 5 (create-booking EF — uses the EF-mirror conversion)   [parallel with 3→4]
                 └──> Task 6 (E2E — needs 4 + 5)
```

- **Lane A:** Task 2 → 3 → 4 (sequential — shared types + `src/lib/pricing` + booking UI).
- **Lane B:** Task 5 (after Task 2's EF mirror exists — touches `supabase/functions`, no overlap with Lane A's `src/`).
- Then Task 6 after both lanes merge. Two lanes; modest parallelism (Lane A is the long pole).

## Implementation Tasks
Synthesized from this review. The phase tasks above are the build steps; these are the review-derived deltas folded in.

- [ ] **T1 (P1, human: ~1h / CC: ~15min)** — services-form — refactor pricing memo onto `computeLineItems` (A1)
  - Surfaced by: Architecture — `services-form.tsx:187-235` is a 4th copy of the dual-limit loop
  - Files: `src/app/(public)/book/services/services-form.tsx`
  - Verify: services-step preview + badges match `computeLineItems`; existing E2E green
- [ ] **T2 (P2, human: ~10min / CC: ~3min)** — engine — guard conversion to `unitMultiplier === 1` (A2)
  - Surfaced by: Architecture — MUD × conversion mis-scales from/to units
  - Files: `src/lib/pricing/calculate.ts`, `supabase/functions/_shared/pricing.ts`
  - Verify: add a unit test asserting MUD multiplier ignores conversion
- [ ] **T3 (P2, human: ~20min / CC: ~5min)** — swap.ts — centralise the multi-FK conversion-rule query helper (A3)
  - Surfaced by: Architecture — same gotcha-prone embed in 3 call sites
  - Files: `src/lib/pricing/swap.ts` (+ callers)
  - Verify: one helper imported by services-form, confirm-form, and the EF query path
- [ ] **T4 (P1, human: ~45min / CC: ~10min)** — create-booking — edit-flow un-swap reconciliation + tests
  - Surfaced by: Code Quality — editing away the Green leaves a stale `allocation_swap`
  - Files: `supabase/functions/create-booking/index.ts`
  - Verify: edit a swap booking to drop Green → `allocation_swap` row removed
- [ ] **T5 (P1, human: ~1h / CC: ~15min)** — tests — EF re-validation + revert-trigger coverage
  - Surfaced by: Test review — EF reject paths + DB revert untested
  - Files: EF integration tests, DB trigger test
  - Verify: reject-used/reject-no-rule/insert/409 + cancel-reverts-swap all green

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | scope reduced (defer DM-Ops sync) + 1 architecture decision (DRY refactor) + 4 bake-ins; 0 critical gaps after additions |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (one checkbox; minimal UI) |
| Outside Voice | `/codex` | Independent 2nd opinion | 0 | — | skipped |

- **UNRESOLVED:** none — both decisions (D1 scope, A1 DRY) answered; A2/A3/edit-flow/tests baked in.
- **VERDICT:** ENG CLEARED — ready to implement. Land bug fix PR #147 + PR-A migration first, then PR-B.
