# Plan — Fix `contacts` SELECT RLS performance (auth_rls_initplan, structural)

**Branch:** `fix/contacts-rls` (base `develop`) · **Date:** 2026-07-09
**Sweep context:** 3rd table after `collection_stop` (#347) and `booking` (#351). PII-critical.
**Reviewed:** /autoplan Eng (subagent-only; Codex over usage limit). Strata rewrite confirmed provably row-equivalent.

---

## Problem

A `contacts` scan under a contractor-admin JWT = **276 ms** (measured on prod with #351
booking wraps already live). `contacts` holds resident/strata **names, emails, phones** —
the admin contacts list, booking-detail embeds, and ticket detail all read it.

## Measured decomposition (impersonated EXPLAIN, prod)

| State | Time | Notes |
|---|---|---|
| Current | 276 ms | bare helpers + structural subplans |
| Pure `(select …)` wrap of all 6 policies | 157 ms | wrap helps but **insufficient** |
| Structural residue | ~137 ms | strata 84 ms (109k scan) + via_profiles 53 ms |

## Fix (three parts, semantics-preserving)

**A. Wrap the bare STABLE helpers** in `(select …)` across all 6 SELECT policies —
`current_user_role` (the strata policy calls it **3×**: outer gate + both inner branches),
`current_user_contact_id`, `current_user_client_id`, `current_user_contractor_id`,
`is_client_staff`. All are STABLE SECURITY DEFINER → provably no visibility change. Leave
`accessible_client_ids()` as `IN (SELECT …)` — do **not** scalar-wrap it.

**B. Strata policy — drive off the selective column.** Rewrite `EXISTS(…)` to a membership
test built from the **326** non-null rows, not the 109k tenant set:
```sql
contacts.id IN (
  SELECT ep.strata_contact_id
  FROM eligible_properties ep JOIN collection_area ca ON ca.id = ep.collection_area_id
  WHERE ep.strata_contact_id IS NOT NULL
    AND (
      ((select current_user_role()) = ANY(ARRAY['contractor-admin','contractor-staff']::app_role[]) AND ca.contractor_id = (select current_user_contractor_id()))
      OR ((select current_user_role()) = ANY(ARRAY['client-admin','client-staff']::app_role[]) AND ca.client_id IN (SELECT accessible_client_ids()))
    )
)
```
- **Both role-gated branches MUST be copied verbatim** (do NOT collapse to `contractor_id=… OR client_id IN …`). Their equivalence today rests on an *unenforced* data invariant (client-tier `user_roles` rows have NULL contractor_id); collapsing them = latent cross-tenant PII leak.
- **`accessible_client_ids()` stays `IN (SELECT …)`, never `= ANY(…)`** — the latter is why PR #97 hard-failed with `0A000` (SRF in scalar position); a re-failed migration ghost-releases (skips Coolify).
- Provably row-equivalent to the EXISTS: only correlation is `strata_contact_id = contacts.id`; NULLs excluded either way; duplicates/shared-across-tenant behave identically.

**Supporting index (Part B):**
```sql
CREATE INDEX idx_ep_strata_contact_area ON public.eligible_properties (collection_area_id, strata_contact_id) WHERE strata_contact_id IS NOT NULL;
ANALYZE public.eligible_properties;   -- CREATE INDEX does NOT refresh stats; planner needs them to flip
```
Leading `collection_area_id` supports the tenant-area probe; trailing `strata_contact_id`
makes it index-only over ~326 rows. **Verify per-role that the planner actually flips**
(contractor viewer = many areas vs client viewer = few → plans can differ).

**C. via_profiles policy — wrap only.** The 53 ms is the two unwrapped
`current_user_contractor_id()` / `current_user_client_id()` firing per row (601 DEFINER
lookups), NOT a `user_roles` scan (601 rows seq-scan in ~0.1 ms). Wrapping collapses them to
InitPlan. **Do NOT add user_roles indexes** (cargo-cult on a 601-row table). Re-measure; only
restructure if still hot.

**Realistic target:** contacts scan **~20-25 ms** (157 wrap − 84 strata − 53 via_profiles ≈ base 20), **identical row set for every role**.

## Equivalence + PII safety (the gate — tenant-isolation change on PII)

**Roles to cover — including the PII red-line roles the first draft omitted:**
contractor-admin, contractor-staff, client-admin, client-staff, resident, strata,
**field, ranger**.

- **Migration-time (manual, one-shot):** dump the visible `contacts.id` set under the OLD
  policies per role, apply, dump under NEW, diff → must be identical. (Can't be a unit test —
  only post-migration state exists at test time.)
- **Standing regression tests (absolute-value, added to `rls.test.ts` — existing contacts
  tests assert `>= 0` and would NOT catch a leak):**
  1. contractor-admin AND client-admin each see an **own-tenant** strata contact via a bare `SELECT id FROM contacts` (not just the RPC path).
  2. **Cross-tenant SELECT negative (most important, currently absent):** a strata contact whose only property is in tenant B → **0** for a tenant-A viewer.
  3. Shared `strata_contact_id` across both tenants → visible to **both** viewers (guards under-exposure).
  4. Duplicate `strata_contact_id` on 2 own-tenant properties → visible **exactly once**, no error.
  5. **field + ranger see 0 contacts**, and creating a strata link does **not** make that contact visible to field/ranger (keep `TC-PII` green + add the strata-specific assertion).
  Two-tenant fixtures exist: `CLIENT_ID` (Kwinana) + `VV_CLIENT_ID` (vergevalet).

## Migration / deploy

`migration new` → partial index + `ANALYZE` + 6 `ALTER POLICY` → CI `db push` → release.
Policy + one index, no schema surface → Types-Freshness unaffected. Rollback = restore
original USING exprs + `DROP INDEX`.

## Out of scope

Contacts WRITE policies (single-row). The remaining small-table sweep + CI `auth_rls_initplan` gate (separate chip).

---

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|-------|----------|-------|-----------|-----------|
| 1 | Eng | Copy both strata role-gated branches verbatim (no `<tenant>` shorthand) | Mechanical | P1 | Collapsing them = latent cross-tenant leak on an unenforced invariant |
| 2 | Eng | Keep `accessible_client_ids()` as `IN (SELECT …)`, never `= ANY` | Mechanical | P5 | SRF-in-scalar = 0A000 hard-fail → ghost release |
| 3 | Eng | Index = `(collection_area_id, strata_contact_id) WHERE strata_contact_id IS NOT NULL` + `ANALYZE` | Mechanical | P5 | Correct column order for the area-probe; stats needed to flip planner |
| 4 | Eng | Drop the user_roles-index idea; wrap suffices for via_profiles | Mechanical | P3/P5 | 601-row table never index-scans; cost is unwrapped per-row helpers |
| 5 | Eng | Add absolute-value standing tests + cross-tenant SELECT negative | Mechanical | P1 | Existing `>=0` tests can't catch a leak; before/after diff is manual-only |
| 6 | Eng | Add **field + ranger** to the role matrix (assert 0 + no strata leak) | Mechanical | P1 | PII red-line roles (CLAUDE.md §4/§20) — omitted in first draft |
| 7 | Eng | Realistic target ~20-25 ms (not <15) | Mechanical | P5 | Matches the measured decomposition |
