<!-- /autoplan restore point: /Users/danieltaylor/.gstack/projects/dmwaste-verco/claude-sentry-review-process-c449c8-autoplan-restore-20260709-101053.md -->
# Plan — Fix `collection_stop` RLS timeout on field run sheets

**Branch:** `claude/sentry-review-process-c449c8`
**Date:** 2026-07-09
**Surfaced by:** Sentry (JAVASCRIPT-NEXTJS-5, -6, -7) — the observability we just switched on.
**Scope (premise gate):** Fix `collection_stop` now; the platform-wide RLS class sweep is a committed follow-up PR (see TODOS).

---

## Problem

`/field` (RunPickerPage) and `/field/runs/[date]/[driver]` (RunSheetByDriverPage)
intermittently throw `canceling statement due to statement timeout`. When it fires,
a **crew member gets an error page instead of their run sheet**. Observed timestamps
map to **08:42 and 09:13 AWST — shift start**, the worst possible moment. Sentry
reports "0 users impacted" only because the `field` role carries zero PII/identity by
design; functionally every occurrence is a crew-blocking crash on the ops-critical path.

## Root cause

**Symptom — proven.** The RLS predicate on `collection_stop` is the cost:
- Tables are tiny (483 stops, 1,338 bookings, 101 on the incident date) — rules out volume.
- Raw query as an RLS-exempt role: **4.6 ms**, both indexes firing.
- Same query as `authenticated`: **8 s+ timeout.** The >1,700× delta is the `collection_stop_select` USING clause.

**Mechanism — hypothesis, decides A vs B, unproven until the impersonated EXPLAIN:**
```sql
USING (
  (booking_id IN (SELECT id FROM booking))                              -- ① uncorrelated subquery, re-runs booking's OWN RLS
  AND (is_field_user() OR is_client_staff() OR is_contractor_user())    -- ② 3 helpers, bare → per row (auth_rls_initplan)
)
```

## Instance #1 of a class defect (verified census → follow-up PR)

Same anti-pattern repo-wide: pattern ① in `initial_schema` (booking_item), `collection_stop`, survey;
pattern ② = **72 bare helper calls, 0 wrapped**. Full sweep + a CI `auth_rls_initplan` gate is the
committed follow-up PR (TODOS), per the premise-gate decision.

## Measured outcome (impersonated EXPLAIN under a field JWT, prod)

| | Before (current) | After (Fix B, rolled back) |
|---|---|---|
| Execution | **866 ms** | **5.6 ms** (~155×) |
| Rows (field user) | 101 | **101** (identical) |
| Dominant cost | `SubPlan 2` = booking seq-scan re-running booking RLS = **806 ms** | gone |
| Helpers | per-scan | InitPlan (once; `user_sub_client_allows_booking` not called — NULL-guard) |

**① dominates → Fix A would have been a near-total no-op. Fix B chosen.** INV-1 and INV-2 both hold in prod (0 violations).

## Fix (B — client_id gate, chosen)

```sql
ALTER POLICY collection_stop_select ON public.collection_stop
USING (
  (client_id IN (SELECT accessible_client_ids()))
  AND ((SELECT is_field_user()) OR (SELECT is_client_staff()) OR (SELECT is_contractor_user()))
  AND ((SELECT current_user_sub_client_id()) IS NULL OR user_sub_client_allows_booking(booking_id))
);
```
- Drops ① entirely; gates on indexed `client_id` (mirrors sibling `collection_stop_field_update`).
- NULL-guard means the `field` and `contractor` paths make **zero** per-row helper calls.
- **Fix A (fallback):** wrap the three helpers in `(SELECT …)` only, leaving ① in place. Provably identical rows, but a no-op if ① dominates — do not ship on a hunch.

## Equivalence — the two invariants B depends on

B replaces booking-transitive scoping with a direct `client_id` gate. It is equivalent for
**every** role only while:
1. `collection_stop.client_id = booking.client_id` (write path already pins it: push EF sets it, `enforce_stop_state_transition` makes it immutable for app writers).
2. `booking.contractor_id = client(booking.client_id).contractor_id` (contractor visibility moved from `booking.contractor_id` → `client.contractor_id`; disagreement = silently lost rows, not a leak).

**Enforce invariant 1 at the DB layer** (write-time trigger asserting `client_id = parent booking.client_id`), not test-only — a leak only becomes possible if this column drifts.

## Verification (must reflect prod, not a 483-row toy)

1. **Cost attribution** — impersonated `EXPLAIN (ANALYZE, BUFFERS)` under a real field JWT; read **actual loop counts** on the helper/subquery, not wall-clock (483 rows can false-green both old and new).
2. **Concurrency** — failures cluster at shift start; run a concurrent-session repro (or reason about pool/`statement_timeout` under load) before calling it fixed.
3. **Row-set equivalence** — same rows before vs after for **field, ranger, client-staff, client-admin, contractor-admin, contractor-staff**, and a **sub-client-narrowed client-admin AND a sub-client-narrowed ranger** (ranger is the role most affected: it's in `is_field_user()`, CAN carry a non-NULL `sub_client_id`, and the run-detail page does not redirect it).
4. **Cross-tenant NEGATIVE tests** (the same-user diff and the invariant assertion do NOT prove denial):
   - a stop under a **second contractor's** client → a D&M `field`/`contractor-admin` sees **0** (mirror `allocation_override` test `rls.test.ts:756-845`).
   - a **COT sub-client** user sees **0** stops on a **MOS** booking; repeat for a scoped **ranger**.
5. **Invariant assertions** — commit real tests for both invariants above (not aspirations).
6. **RLS smoke test** in the suite (visibility per role unchanged).

Residual (accepted): `user_sub_client_allows_booking(booking_id)` is correlated, so a
**sub-client-scoped** client-admin/ranger loading a large bucket still pays a per-row DEFINER
call — narrow, low-volume; the `get_run_sheet` RPC (alt C) is what would kill it for all callers.

## Alternatives considered

| Approach | Effort (CC) | Risk | Verdict |
|---|---|---|---|
| A — InitPlan wrap | ~10 min | Very low | Fallback only (no-op vs ①) |
| **B — client_id gate** | ~25 min | Low | **Chosen** — precedented, drops ①, zero per-row for field/contractor |
| C — `SECURITY DEFINER` RPC `get_run_sheet(date,driver)` | ~1 day | Med | Deferred. House pattern for bounded reads; kills the class for this surface but rewrites both page consumers (bigger blast radius) and drops RLS-as-contract. Revisit if B underperforms or for the scoped-user residual. |

## Migration / deploy

- `pnpm supabase migration new fix_collection_stop_select_rls_timeout` → `ALTER POLICY` + the invariant write-trigger → CI `db push` → release. **Never** MCP `apply_migration` on prod.
- No types regen (policy-only, no schema surface).

## Rollback

`ALTER POLICY collection_stop_select ... USING (<original expr>)` + drop the trigger — instant.

## Out of scope (deferred, not dropped) → TODOS

- **Platform-wide RLS class sweep** + CI `auth_rls_initplan` gate (follow-up PR — premise-gate decision A).
- **Field-session non-PII impact tagging** so "0 users impacted" isn't structurally blind on the field surface (Sentry review-process workstream).
- The `fetchAllRows` paginator — **not** the cause; do not touch.

---

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|-------|----------|-------|-----------|-----------|----------|
| 1 | CEO | Make Fix B the default; measure ① vs ② first | Mechanical | P1/P3 | A leaves ① untouched; if ① dominates, A is a no-op and burns a release | "Ship A first" |
| 2 | CEO | Reword root cause: symptom proven, mechanism is hypothesis | Mechanical | P5 | Don't greenlight A believing attribution is settled | Leaving "proven" |
| 3 | CEO | Verify via actual loop counts (ANALYZE BUFFERS) + concurrency | Mechanical | P1 | 483-row wall-clock can false-green; shift-start clustering implies load | Wall-clock-only |
| 4 | CEO | Add `client_id = booking.client_id` invariant | Mechanical | P1 | B shifts trust to the denormalized column on the read path | Row-count-only equivalence |
| 5 | CEO | Hoist sub-client NULL check in Fix B | Mechanical | P5 | Unwrapped helper = same per-row cost class being removed | Leaving it bare |
| 6 | CEO | Justify RPC dismissal with house-pattern reasoning | Mechanical | P5 | RPC is the established pattern for bounded reads | Silent dismissal |
| 7 | CEO | Defer field-session impact tagging to Sentry workstream | Mechanical | P2 | Out of RLS blast radius | Folding into this PR |
| 8 | CEO | Scope (instance vs class) → premise gate → **A** | Taste | — | User chose: fix now + sweep as follow-up PR | B / C |
| 9 | Eng | Add **ranger** to equivalence matrix + scoped-ranger negative | Mechanical | P1 | ranger ∈ is_field_user(), can carry sub_client_id, run-detail page doesn't redirect it | Omitting ranger |
| 10 | Eng | Add cross-tenant + cross-sub-client NEGATIVE tests | Mechanical | P1 | Same-user before/after diff passes even if both leak identically | Diff-only verify |
| 11 | Eng | Add 2nd invariant (contractor_id) + enforce client_id invariant via write-trigger | Mechanical | P1/P5 | Contractor path gates on client.contractor_id; trust depends on the column staying in sync | Test-only invariant |
| 12 | Eng | Document residual per-row cost for scoped client-tier/ranger | Mechanical | P5 | `user_sub_client_allows_booking` is correlated, can't be hoisted | Implying full elimination |
