# NCN/NP — Exceptions vs Investigations model

- **Date:** 2026-07-06
- **Status:** Reviewed (plan-eng-review 2026-07-06) — ready to implement
- **Author:** Claude (brainstormed + eng-reviewed with Dan)
- **Related memory:** `ncn-np-record-tables-unpopulated`, `ncn-np-workflow`, `field-stops-optimoroute-architecture`, `tenant-gate-is-not-an-authz-gate`

---

## 1. Problem

The sidebar Exception badges, the two Exception list tables, and the admin dashboard exception surfaces read from **different sources**, so they disagree.

| Surface | Current source | Prod value (06/07/2026) |
|---|---|---|
| Sidebar badge — Non-Conformance | `booking.status = 'Non-conformance'` | **5** |
| Table `/admin/non-conformance` | `non_conformance_notice` records | **0** |
| Sidebar badge — Nothing Presented | `booking.status = 'Nothing Presented'` | **4** |
| Table `/admin/nothing-presented` | `nothing_presented` records | **10** |
| Dashboard "Open Exceptions" card + list | `booking.status IN (…)` | 9 |

**Why the counts diverge:**
- The **5 NCN bookings** are `created_via = 'legacy'` Airtable imports (MOS/COT). Their *status* was imported, but the collection never ran through Verco's field closeout, so no `non_conformance_notice` record exists. Expected, not a bug.
- The **10 NP records** were created by Verco's real stop closeout (`raiseNpForStop`); 6 sit on bookings since moved to Rebooked/Completed, so the record table over-reports vs current status.
- Field closeout **does** create notice records now (`raiseNcnForStop` / `raiseNpForStop`, `src/app/(field)/field/stops/[id]/actions.ts`). The historical gap is only legacy imports. *(This supersedes the `ncn-np-record-tables-unpopulated` memory, which predates confirming the closeout insert.)*

## 2. The model

- **Exception** — a raised **notice record** (`non_conformance_notice` / `nothing_presented`). This is the **source of truth**, NOT `booking.status`. A notice is raised per **stop = booking × waste stream**, so one booking can carry **several** records — even both an NCN and an NP (different streams), and a record can exist while the booking is still `Scheduled` (other streams pending). `booking.status` is a downstream *rollup* of its stops, not the exception list source. The 5 legacy Airtable NCNs are the only record-less exceptions — closed by a one-time backfill.
- **Investigation** — a notice record's lifecycle: `Issued → Disputed → Under Review → Resolved / Rescheduled(NCN) / Rebooked(NP) / Closed`. "Open investigation" = `Disputed`/`Under Review`.

**Model correction (eng-review, Codex #2/#3/#12):** the earlier framing "exception = one booking in NCN/NP status" was wrong — notices are stream-level and their lifecycle is independent of `booking.status`. Every read surface keys off notice records; `booking.status` is never the list source. (Concrete: prod has 4 NP records on still-`Scheduled` bookings — legitimately shown, per T2.)

```
 EXCEPTION (booking.status)              INVESTIGATION (notice record)
 ─────────────────────────              ─────────────────────────────
 field closeout ─┐
                 ├─► booking = NCN/NP ──► record created (Issued)
 legacy import ──┘        │                     │
       (backfill) ────────┴──► Closed record   dispute (resident)  ─► Disputed
                                                staff open-on-behalf ─► Under Review
                                                        │
                                            Resolved / Rescheduled / Rebooked / Closed
                                                        │
 BADGE + dashboard card = records in {Disputed, Under Review}  ◄──────┘ (the "open" subset)
 TABLE = every record (all exceptions incl. history), default filter = open subset
```

State groupings (`ncn_status` / `np_status`; `Open` enum value is unused legacy):

| Group | States |
|---|---|
| **Open investigation** (badge + dashboard) | `Disputed`, `Under Review` |
| Table default "open" filter | `Issued`, `Disputed`, `Under Review` |
| Terminal | `Resolved`, `Rescheduled` (NCN), `Rebooked` (NP), `Closed` |

## 3. Locked decisions

1. **Badge = open investigations** — `Disputed` + `Under Review` notice records, client-scoped.
2. **Tables = all exceptions incl. resolved history** — query the record tables directly (every exception has a record after backfill). Status filter **defaults to open** (`Issued` + `Disputed` + `Under Review`); switch to any state or All for history.
3. **Dashboard NCN/NP surfaces = open investigations** — card + list use the same `Disputed`+`Under Review` definition. Rename "Open Exceptions" → **"Open Investigations"** (OQ3). The "This week" NCN/NP tallies stay keyed off `booking.status` (they measure weekly outcomes, not investigation state).
4. **Backfill, not union views** (eng-review D2) — a one-time **set-based** migration inserts a `Closed` record for **every** exception-booking lacking one (not a hardcoded 5), so every surface reads the record tables uniformly. No union views, no synthetic status.
5. **Legacy backfill lifecycle = Closed** (eng-review 1A) — backfilled rows land terminal (`status=Closed`, `reason='Other'` for NCN, `resolution_notes='Imported from Airtable — status only'`), so the open queue reads a truthful 0 and the auto-close cron ignores them. Visible via history filter + booking-detail card.
6. **Invariant safety net** (eng-review 1A(3)) — the backfill is re-runnable (set-based), and the admin dashboard shows a cheap read-time warning banner when any record-less exception exists (loud failure if a future import re-breaks the invariant). No new cron.
7. **Staff/admin open investigations on behalf of residents** — creates a record (shouldn't occur post-backfill, defensive) or advances an `Issued` one to `Under Review`, relaxing the "staff can't touch Issued" gate. Contractor/client admin+staff only — never field/ranger.
8. **RLS hardening** (eng-review A2, learning `tenant-gate-is-not-an-authz-gate`) — the new staff INSERT/UPDATE policies MUST carry the §21 NULL-safe staff **role** gate in addition to `client_id IN (accessible_client_ids())`. Tenant scope is not an authz gate — `accessible_client_ids()` returns a row for resident/field/ranger too.
9. **DRY the new code, TODO the old dup** (eng-review 2C) — one `openInvestigation(kind, …)` action + one shared `ExceptionCard`. Leave the two existing table clients separate; log "unify exception table clients" as a TODO.
10. **Phased into 3 PRs to `develop`** (§9).

### Expectation to flag on ship
After Part 1, **both Exception badges + the dashboard card read 0** until an investigation is opened (staff-on-behalf or resident dispute) — no `Disputed`/`Under Review` records exist today. Intended "needs attention" signal. All exceptions still show in the tables (legacy 5 as Closed history).

---

## 4. Part 1 — Badge, tables & dashboard consistency (backfill)

### 4.1 Backfill migration (set-based, re-runnable)
```sql
-- Insert a Closed investigation record for EVERY exception-booking lacking one.
-- Set-based (not a hardcoded count) → correct + re-runnable after future imports.
INSERT INTO non_conformance_notice (booking_id, client_id, reason, status, notes, resolution_notes, reported_at, resolved_at)
SELECT b.id, b.client_id, 'Other', 'Closed', NULL,
       'Imported from Airtable — status only (backfilled 2026-07)', b.created_at, now()
FROM booking b
WHERE b.status = 'Non-conformance'
  AND NOT EXISTS (SELECT 1 FROM non_conformance_notice n WHERE n.booking_id = b.id);
-- Analogous for nothing_presented (no reason column).
```
Assert an invariant, not a count (CLAUDE.md seed-migration rule). Re-running inserts 0 rows. `created_at` (not `updated_at`) as `reported_at` — `updated_at` may reflect an unrelated later edit (Codex #11). NOT a unique constraint on `booking_id`: legitimate multiple records per booking (per stream), so the guard is per-booking existence only for the record-less *legacy* set.

### 4.2 Sidebar badge — `src/app/(admin)/admin/layout.tsx`
`ncnQuery`/`npQuery` change from `booking.status` counts to notice-record counts where `status IN ('Disputed','Under Review')`, client-scoped. Service-ticket badge already correct.

### 4.3 Exception tables — `non-conformance-client.tsx`, `nothing-presented-client.tsx`
Already query the record tables. Changes: Status filter **defaults to open** (`Issued`/`Disputed`/`Under Review`) instead of showing everything; keep All + per-state options for history. **List every record immediately, incl. partial-closeout ones whose booking is still `Scheduled`** (T2-A — a raised notice is a real exception; do NOT filter by `booking.status`). Add/keep columns for **stream** and **booking status** so a `Scheduled` booking with an NP row reads clearly. `reported_by IS NULL` legacy rows render reporter as "—". Row "View" → existing `/admin/{type}/[id]` detail; record-less rows won't exist post-backfill.

### 4.4 Dashboard — `src/app/(admin)/admin/page.tsx`
- "Open Exceptions" card + list → `Disputed`+`Under Review` records; rename to "Open Investigations".
- Add a read-time **record-less warning banner**: `booking` in exception status with `NOT EXISTS` a record → "N exceptions missing an investigation record — re-run reconciliation." Bounded anti-join, cheap.

---

## 5. Part 2 — Open an investigation on behalf

### 5.1 Server action — one, parameterised (DRY)
`openInvestigation({ kind: 'ncn' | 'np', bookingId, reason? })` (mirrors resolution-action pattern in `.../[id]/actions.ts` — `verifyStaffRole()`, `Result<T>`, zod). Resolve `client_id`; assert booking is the matching exception status. Existing `Issued` record → UPDATE to `Under Review`. No record (defensive) → INSERT `Under Review`, `reported_by = auth.uid()`, `reason` required for NCN. Already `Under Review`/`Disputed` → no-op success; terminal → reject.

### 5.2 RLS changes (same migration; HARDENED per decision 8 + Codex #7/#8)
The server action is defence-in-depth, **not** the invariant boundary — direct SDK access is governed only by RLS, so the rules below enforce at the DB:
- **INSERT:** contractor/client admin+staff may insert for a booking in `accessible_client_ids()`, **AND** `(current_user_role() IN ('contractor-admin','contractor-staff','client-admin','client-staff')) IS TRUE`, `WITH CHECK` pinning `status='Under Review'` + `client_id` scope. Field closeout INSERT policy untouched.
- **UPDATE:** extend staff update policy to allow `Issued → Under Review` only, same NULL-safe role gate. Because Postgres RLS can't express column-level immutability in a policy, add a **BEFORE UPDATE trigger** that rejects staff changes to `booking_id`/`client_id`/`reason` and rejects terminal→active transitions (Codex #7). Reason-required-for-NCN and reject-terminal live in the trigger too, not just the action (Codex #8).
- Resident dispute policies untouched (regression-tested).

### 5.3 Entry points
Exception table row action + booking-detail `ExceptionCard` button ("Open investigation"). Field/ranger never see it.

### 5.4 Actor & notifications
Actor via existing `audit_trigger_fn()`. **OQ1:** notify resident on open-on-behalf — default **no**. **OQ2:** provenance beyond audit — default audit-log only.

---

## 6. Part 3 — Booking-detail cards

### 6.1 Shared `ExceptionCard` (DRY)
One component, rendering **all** of a booking's exception records — a booking can have several (one per stream) and **both an NCN and an NP** (Codex #12), so the card iterates, not single-shows. Per record: reason(NCN)/stream/status/photos/reported_at + View / Open-investigation (staff). No records → nothing rendered. Consumed by both detail views.

### 6.2 Admin — `src/app/(admin)/admin/bookings/[id]/page.tsx` (+ client)
Currently fetches neither. Add: Exceptions card (fetch notice for exception-status bookings) + Service Tickets card (`service_ticket` by `booking_id`, link to `/admin/service-tickets/[id]`).

### 6.3 Resident — `src/app/(public)/booking/[ref]/page.tsx` (+ client)
Already fetches tickets (works) + notice records (renders when present). Swap its inline NCN/NP card markup for the shared `ExceptionCard`; dispute affordance stays gated to own `Issued` record (RLS). Dashboard open-filter does not apply here.

---

## 7. Cross-cutting: data, types, security

- **Migrations:** backfill + RLS changes via `supabase migration new` → CI `db push` (never MCP `apply_migration` on prod). No new views/RPCs → **no Types-Freshness split needed** (no schema shape change beyond data + policies); regen types only if a column/enum is added (none planned).
- **No Edge Function** — server action + RLS suffices (no service-role work, no external calls). Backfill is a plain SQL migration.
- **Security:** decision 8 is the load-bearing one — staff write policies gate on role, not just tenant.

## 8. Testing (coverage map from eng-review §3)

100% of new paths. Highlights: badge count query; **backfill idempotency (CRITICAL — re-run inserts 0)**; table default-open filter; dashboard record-less banner; `openInvestigation` branches (create/advance/reject-terminal/reason-required/non-staff/cross-tenant); **3 REGRESSION smokes (CRITICAL): field closeout INSERT, resident dispute Issued→Disputed own-only, badge behaviour**; RLS staff INSERT/UPDATE with role gate; `ExceptionCard` render states; E2E open-on-behalf (click → record → badge updates) + both booking-detail views.

## 9. Rollout / phasing (3 PRs → `develop`)

| PR | Scope |
|---|---|
| **1** | Backfill migration + badge redefinition + table default-open filter + dashboard card/rename/warning — the consistency fix |
| **2** | `openInvestigation` action + hardened RLS + table/card buttons |
| **3** | Shared `ExceptionCard` + admin booking-detail Exceptions/Tickets cards + resident card swap |

**Release gate (eng-review T1-B):** PR1 flips the badge to "open investigations" (→0) but the staff open path lands in PR2. Do NOT cut a `develop→main` release with PR1 alone — the batch must include **at least PR1+PR2** so prod never shows a dead badge with no staff path. PRs stay separate + focused; only the release is gated.

## 10. Open questions (for review)
- **OQ1 — Notify resident when staff open on behalf?** Default: no.
- **OQ2 — Provenance beyond audit_log?** Default: audit-log only.
- **OQ3 — Rename dashboard "Open Exceptions" → "Open Investigations"?** Decided: yes (decision 3).

## 11. NOT in scope
- Changing field closeout / `rollup_booking_status_from_stops`.
- Union-view dual-source architecture (rejected D2 in favour of backfill).
- Unifying the two exception table clients (TODO, decision 9).
- Refund / `contractor_fault` / rebook-pricing (set at resolution, unchanged).
- Service-ticket badge/table (already table=all, badge=open).
- A self-healing reconciliation cron (rejected 1A(3) in favour of set-based backfill + warning banner).
- Making notice tables authoritative and *deriving* `booking.status` from them (Codex #18) — correct long-term direction but a large rewrite touching the closeout rollup; explicitly deferred. This plan reads records as the exception source without changing how `booking.status` is produced.

## 12. What already exists (reuse, not rebuild)
- Notice tables + state machine + detail pages + resolution actions (`.../non-conformance/[id]/actions.ts`, `.../nothing-presented/[id]/actions.ts`) — reused.
- Field closeout creates records (`raiseNcnForStop`/`raiseNpForStop`) — the exception source; unchanged.
- Resident booking detail already fetches tickets + notice records (`booking/[ref]/page.tsx`) — Part 3 swaps in the shared card, doesn't rebuild the fetch.
- `verifyStaffRole`, `Result<T>`, Base UI Dialog, `StatusBadge`, admin `PageHeader`/`FilterBar`/`Th`/`Pagination`, `audit_trigger_fn` — all reused.

## 13. Failure modes (new codepaths)

| Codepath | Realistic failure | Test | Error handling | Silent? |
|---|---|---|---|---|
| Backfill migration | double-insert on re-run | idempotency (CRITICAL) | `NOT EXISTS` guard | no |
| Badge query | wrong status set → miscount | unit | n/a | no |
| `openInvestigation` **race** (two staff open same record) | lost update / dup | unit + guard | **row-count guard `.eq('status','Issued')` (mirror closeout)** | would be silent → **guard required (T5)** |
| RLS relax | staff tampers `booking_id`/terminal→active | RLS smoke | BEFORE UPDATE trigger | no |
| Dashboard banner | anti-join wrong → never shows | unit | n/a | yes → test covers |
| `ExceptionCard` | booking with NCN+NP shows one | unit | iterate all records | yes → test covers |

No failure is left with *no test AND no handling AND silent* — the `openInvestigation` race is the closest and is closed by the row-count guard (T5). **0 critical gaps.**

## 14. Worktree parallelization
Largely **sequential**: PR2 depends on PR1's migration + model; PR3 depends on PR2's action. Within PR3, the admin card (T8) and resident card swap (T9) touch different route groups → parallel lanes. `Lane A: T1→T2→T3→T4 (PR1) → T5→T6 (PR2) → T7 (PR3)` | `Lane B (after T7): T8 ∥ T9`.

## 15. Implementation Tasks
Synthesized from this review's findings. Checkbox as shipped.

- [ ] **T1 (P1, human: ~1h / CC: ~15min)** — migration — set-based backfill of `Closed` legacy records + idempotency test
  - Surfaced by: D2 + 1A — backfill approach, Closed lifecycle, `created_at` timestamp
  - Files: `supabase/migrations/`, `src/__tests__/` (or SQL RAISE-rollback verify)
  - Verify: re-run inserts 0 rows; 5 NCN rows land Closed
- [ ] **T2 (P1, human: ~30min / CC: ~5min)** — `admin/layout.tsx` — badge = records `Disputed`+`Under Review`
  - Surfaced by: Section 1 / decision 1
  - Verify: badge unit test per status set
- [ ] **T3 (P1, human: ~2h / CC: ~20min)** — exception table clients — default-open filter + show all records incl partial-closeout + stream/booking-status columns
  - Surfaced by: T2-A tension
  - Files: `non-conformance-client.tsx`, `nothing-presented-client.tsx`
- [ ] **T4 (P2, human: ~2h / CC: ~20min)** — `admin/page.tsx` — dashboard card/count → open investigations, rename, record-less warning banner
  - Surfaced by: dashboard decision + 1A(3)
- [ ] **T5 (P1, human: ~3h / CC: ~25min)** — `openInvestigation` action (parameterised) + race guard + full branch tests
  - Surfaced by: Part 2 + failure-modes race
  - Verify: create/advance/reject-terminal/reason-required/non-staff/cross-tenant + concurrent-open guard
- [ ] **T6 (P1, human: ~3h / CC: ~30min)** — RLS INSERT/UPDATE (NULL-safe role gate) + immutability BEFORE UPDATE trigger + 3 regression smokes
  - Surfaced by: A2 + Codex #7/#8 + IRON regression rule
  - Verify: field closeout, resident dispute, badge behaviour all still pass
- [ ] **T7 (P2, human: ~2h / CC: ~20min)** — shared `ExceptionCard` iterating all of a booking's records (incl NCN+NP)
  - Surfaced by: 2C-A + Codex #12
- [ ] **T8 (P2, human: ~1.5h / CC: ~15min)** — admin booking-detail Exceptions + Service Tickets cards
- [ ] **T9 (P2, human: ~1h / CC: ~10min)** — resident booking-detail swap to `ExceptionCard`
- [ ] **T10 (P2, human: ~1.5h / CC: ~20min)** — E2E: staff open-on-behalf → record → badge updates; both detail views

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | clean | 18 raised; key ones folded |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 7 decisions resolved, 0 unresolved, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** ran (ready). 18 findings; folded: stream-level model correction (#2/#3/#12), DB-level RLS/trigger enforcement (#7/#8), `created_at` backfill timestamp (#11). Deferred: notice-authoritative rewrite (#18). Re-litigated-but-user-decided: `Issued` excluded from badge (#4), banner-over-cron (#9).
- **CROSS-MODEL:** two tensions surfaced → resolved. T1 (sequencing) → hold release until PR1+PR2 (B). T2 (partial-closeout records) → show all records immediately (A). No open disagreements.
- **VERDICT:** ENG CLEARED — ready to implement. Scope reduced (union views → backfill).

NO UNRESOLVED DECISIONS
