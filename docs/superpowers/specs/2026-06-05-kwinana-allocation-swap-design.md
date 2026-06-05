# Allocation Swap — Kwinana (Ancillary → Green)

**Date:** 2026-06-05
**Status:** Design — awaiting review
**Author:** Dan + Claude (from the Kwinana meeting)

---

## 1. Problem

City of Kwinana residents get a fixed FY allocation: **2 Bulk** (General/Green) + **3 Ancillary** (E-Waste/Whitegoods/Mattress). Some households have no ancillary items to dispose of but want an extra green-waste collection. The prototype let them **swap their whole Ancillary allocation for one extra free Green collection**, via a single checkbox on the services step. That module was never carried into v2.

This spec adds it back, config-driven, aligned with the existing DM-Ops `allocation_conversion_rule` table.

## 2. The rule (agreed)

- **Conversion:** give up **3 Ancillary → gain 1 free Green** collection. All-or-nothing.
- **Target:** Green **only** (hard-enforced in UX *and* re-validated server-side).
- **Eligibility:** offered only when the property has **0 Ancillary used this FY** (none booked, none in the current cart, no swap already applied).
- **Scope:** config-driven. A conversion rule per collection area drives it; Kwinana's four areas are seeded. Other clients light up automatically if a rule is added.
- **Lifetime:** property + FY scoped. Once applied, Ancillary is 0 for the rest of the FY and Bulk gains 1 (channelled to Green). Cancelling the booking that triggered the swap **reverts** it (restores Ancillary).

## 3. Why the dual-limit engine makes this clean

`computeLineItems` already prices each line as `free = MIN(qty, category_remaining, service_remaining)`. A swap is just a budget adjustment applied for a property/FY when an active swap exists:

| Bucket | Base (Kwinana) | After swap |
|---|---|---|
| Ancillary **category** max | 3 | **0** (− `from_units`) |
| Bulk **category** max | 2 | **3** (+ `to_units`) |
| Green **service** max | 2 | **3** (+ `to_units`) |
| General **service** max | 2 | 2 (unchanged) |

Because General's service cap stays at 2, the extra Bulk slot is **only** fillable by Green — Green-only enforcement falls out of the existing `MIN()` with no special-case branch. Ancillary at 0 means any ancillary item is immediately paid (or, in practice, the steppers are disabled once swapped).

## 4. Data model

### 4.1 `allocation_conversion_rule` (mirror of DM-Ops)

New Verco table, mirroring DM-Ops `allocation_conversion_rule` so the nightly sync and admin tooling stay consistent. Verco adds `to_service_id` to make the Green target explicit (DM-Ops stores only category-level).

```
allocation_conversion_rule
  id                        uuid pk
  from_allocation_rules_id  uuid  → allocation_rules(id)   -- Ancillary, per area
  to_allocation_rules_id    uuid  → allocation_rules(id)   -- Bulk, per area
  to_service_id             uuid  → service(id)            -- Green (Verco-specific, hard target)
  from_units                numeric not null               -- 3
  to_units                  numeric not null               -- 1
  is_active                 boolean not null default true
```

- **RLS:** public-SELECT (like `allocation_rules`/`service_rules` — needed for the unauthenticated `/book` flow). Writes are contractor-admin only (no admin UI in v1 — seeded by migration).
- **Seed:** four rows for KWN-V-1…4 (Ancillary→Bulk, `to_service_id` = Green, 3→1), resolved from the existing Kwinana `allocation_rules` + `service` rows.

### 4.2 `allocation_swap` (applied-swap state)

Records that a property forfeited Ancillary for the FY. Read by the pricing data-loaders (the same way FY usage is).

```
allocation_swap
  id                            uuid pk
  property_id                   uuid  → eligible_properties(id)
  fy_id                         uuid  → financial_year(id)
  collection_area_id            uuid  → collection_area(id)
  allocation_conversion_rule_id uuid  → allocation_conversion_rule(id)
  booking_id                    uuid  → booking(id)   -- the booking that triggered it
  created_at                    timestamptz default now()
  UNIQUE (property_id, fy_id)                          -- at most one active swap per property/FY
```

- **RLS:** resident sees own (via property→contact path); contractor/client staff see their scope; `field`/`ranger` excluded (no PII, but also not needed). Insert via the `create-booking` EF (service role) only.
- **Revert:** when the triggering booking is cancelled, delete the `allocation_swap` row (restores Ancillary). Handled in the cancellation path / a trigger on `booking.status → Cancelled`.

## 5. Pricing engine change (`computeLineItems` + EF mirror)

Add an optional `conversion` input. Both `src/lib/pricing/calculate.ts` and `supabase/functions/_shared/pricing.ts` change identically (kept in sync per CLAUDE.md §6).

```ts
interface ActiveConversion {
  from_category_code: string   // 'anc'
  to_category_code: string     // 'bulk'
  to_service_id: string        // Green
  from_units: number           // 3
  to_units: number             // 1
}
// computeLineItems(..., conversion?: ActiveConversion)
//   if conversion present:
//     categoryMaxMap[from] -= from_units      (floored at 0)
//     categoryMaxMap[to]   += to_units
//     rulesMap[to_service_id].max_collections += to_units
```

Applied *before* the per-line `MIN()` loop. Unit tests cover: swap unused, swap + 1 Green (free), swap + 2 General + 1 Green (Green free, General within base), swap + any Ancillary (paid/blocked), swap + General beyond 2 (paid), MUD interaction (out of scope for v1 — see §9).

## 6. Booking flow

### 6.1 Services step (`services-form.tsx`)
- Fetch the active `allocation_conversion_rule` for the area + whether a swap is already applied + Ancillary FY usage (already fetched).
- Render the checkbox **only** when a rule exists AND Ancillary FY usage = 0 AND no existing swap AND no Ancillary in the current cart:
  > ☐ *Swap my 3 ancillary collections for 1 extra green waste collection*
- On tick: set a `swap` flag in component state → pass `conversion` to the client `computeLineItems` preview, disable + zero the Ancillary steppers, and surface the bonus ("1 Green now included"). Carry `swap=true` in the URL params to the date/details/confirm steps.
- On untick: restore Ancillary steppers.

### 6.2 Confirm step (`confirm-form.tsx`)
- Depends on the **confirm-page bug fix** (separate PR — see §8): once the confirm breakdown uses the shared engine, the swap is reflected automatically. Show a line: *"Ancillary allocation swapped — 1 Green included"*.

### 6.3 `create-booking` EF
- Re-run pricing with the conversion (red line #1 — never trust the client). Reject if: Ancillary FY usage ≠ 0, the cart's free Green isn't the swapped unit, or no active rule for the area.
- On success, insert the `allocation_swap` row (property, fy, rule, booking_id) inside the same transaction as the booking.

## 7. DM-Ops sync

`nightly-sync-to-dm-ops` includes the swap so DM-Ops reflects it (the bookings already sync; add the swap marker / the `allocation_swap` equivalent). DM-Ops already holds the rule config — Verco does not write to DM-Ops; it only syncs its own booking + swap state outward via the existing EF.

## 8. Relationship to the confirm-page bug

The confirm page currently reimplements pricing with service-only logic and so already mis-renders category-cap-driven paid units (separate bug, its own PR). That fix — **make `confirm-form.tsx` call `computeLineItems`** — is a prerequisite: once it uses the shared engine, the swap renders correctly with no extra confirm-page work. Land the bug fix first.

## 9. Out of scope (v1)

- Admin UI to create/edit conversion rules (seeded by migration; admin-config later).
- Bidirectional or partial swaps (Bulk→Ancillary, 1-unit swaps).
- Non-Green targets / per-client target services beyond the seeded config.
- MUD / admin-on-behalf swaps — the checkbox is resident self-serve; MUD allocation already scales by units and is a separate flow. Note as future.

## 10. Testing

- **Pricing engine:** 100% — all swap permutations in §5 (Node + EF mirror identical).
- **State/eligibility:** checkbox shows/hides correctly vs Ancillary usage; revert on cancel.
- **E2E:** resident swaps → books free Green → dashboard shows it; tries to add Ancillary after swap → blocked.
- **RLS:** `allocation_conversion_rule` public-SELECT; `allocation_swap` per-role smoke test.

## 11. Migration / release sequencing (per CLAUDE.md §21 ghost-release + types-freshness)

1. **PR-A** — migration (both tables + RLS + seed) only → release → prod → regen types.
2. **PR-B** — pricing engine `conversion` input + EF + services-form checkbox + confirm rendering, against the regen'd types.

(Single PR would fail the Types Freshness CI because the new tables/columns aren't in prod-generated types yet.)
