# Verge Valet Staged Go-Live & EAS Rollout — Decision + Gate Design

**Date:** 2026-06-22
**Status:** Strategy approved (Dan); scope expanded to full Stage 1 after reading WMRC's rollout minutes (22/06). Eng review done — workstreams tracked in Linear epic VER-268.
**Context owner:** Dan Taylor · **Drafted with:** Claude Code

---

## 1. Context

WMRC reviewed the new Verco booking system and is **not yet confident it has been thoroughly tested**. They do not want a full rollout, and specifically do not want a brand-new council — Town of East Fremantle (EAS) — to hit hiccups during onboarding on an unproven system.

Decisions from the 2026-06-22 WMRC meeting (Jared Crowe, cc Brett McInnes, Libby Eustance):

- **Phased rollout.** Mosman Park (MOS), Cottesloe (COT), Peppermint Grove (PEP) go live on the new system **Mon 29 June**.
- **EAS goes live 1 July on the old system** — the existing Softr-on-Airtable app at `vergevalet.verco.au`.
- Remaining councils — Cambridge (CAM), Fremantle (FRE), South Perth (SOP), Subiaco (SUB), Victoria Park (VIC), Vincent (VIN) — onboard in later stages.
- New homepage banner + ongoing UI/UX changes (tracked separately).

EAS requires the **full transactional surface**: public self-serve booking **and** staff-managed bookings, allocation limits, and paid extra services. It is not a reduced-risk subset.

---

## 2. Options considered

| Option | Summary | Verdict |
|---|---|---|
| **Softr skinned over new Supabase** | New no-code front-end pointed at the new backend, themed to look like the old system | **Rejected.** EAS needs the full pricing/capacity/Stripe surface, so Softr would have to call our existing Edge Functions → it runs the *same* unproven backend WMRC is nervous about, adds a less-tested front-end + its own auth/RLS surface, and is throwaway. Same risk, more work, doesn't address the concern. |
| **Wait — EAS as a later stage once new system is proven** | Let MOS/COT/PEP prove the system first, then EAS | **Rejected for 1 July.** Only ~2 days of production before EAS → effectively no track record. EAS can't wait. |
| **EAS on genuine old Softr system, migrate later** | Add EAS to the existing, proven Softr+Airtable app; migrate to Verco once the new system is proven | **Chosen.** Truly proven, already handles allocation + paid, exactly what WMRC asked for. Parallel-data pain is real but time-boxed. |

**Key reframe:** almost all the risky logic (eligibility, dual-limit pricing, capacity advisory-lock, Stripe, state machine) lives in the Supabase **backend** (Edge Functions + RPCs), not the front-end. Any option that runs on the new backend inherits the maturity risk WMRC raised — a different shell can't shed it. The only honest levers are (a) use a genuinely proven separate system, or (b) make the new backend demonstrably proven. The old Softr app is already (a); hardening + a clean production run is (b).

---

## 3. Decision

1. **EAS → existing old Softr+Airtable** at `vergevalet.verco.au` for **1 July**. Migrate to Verco as a fast-follow once the new system has a production track record on MOS/COT/PEP. *(Old-system setup + the 6 EAS staff logins are old-system ops, outside this repo.)*
2. **New system → phased rollout** on `vvtest.verco.au` (already the `vergevalet` client's `custom_domain`). Councils enabled one stage at a time via a per-council gate. URL stays `vvtest` for now (Dan's call; revisit before broad rollout — "test" in a live resident URL is a perception risk against the exact confidence WMRC wants).
3. **Final cutover** → repoint `vergevalet.verco.au` DNS to the new app once all councils are onboarded; the proxy then resolves it via the `vergevalet` slug. Retire old Softr.

---

## 4. Verco build — staged go-live gate

### Problem
All 10 Verge Valet councils' data (sub-clients, collection areas, ~90k eligible properties) is loaded in the one new-system instance. The booking address lookup in `src/app/(public)/book/address-form.tsx` and the `create-booking` Edge Function resolve **any** loaded property under the `vergevalet` client — with **no check on `collection_area.is_active` or `sub_client.is_active`**. Both flags exist and default `true`; nothing reads them as a gate. So the moment `vvtest.verco.au` is live, all 10 councils — including EAS and the 6 held-back — are bookable. EAS bookable on the new system *while live on old Softr* = the double-booking hiccup WMRC fears.

### Gate design
- **Client lookup gate:** add `collection_area.is_active = true` (via the existing `!inner` embed) to the property lookup in `address-form.tsx` — both the `place_id` path and the ILIKE fallback.
- **Server defence-in-depth:** `create-booking` rejects a booking whose resolved `collection_area.is_active = false`, so a crafted request can't bypass the client gate. (Evaluate `calculate-price` for the same guard.)
- **Gate level:** `collection_area.is_active` — the lookup already joins `collection_area`, it's one flag per area, and MOS/COT/PEP are one area each. `sub_client.is_active` mirrors it for admin clarity.
- **Data:** `is_active = true` for MOS/COT/PEP areas; `false` for the other 7 councils' areas (incl. EAS).
- **Admin control:** a per-council/area toggle in the admin client-config UI, so each future stage is an ops action, not a redeploy.
- **Messaging:** an address resolving to an inactive area shows a distinct "not yet available online — contact your council" message, **not** the red "not eligible". Final copy may land with the UI/UX batch.
- **Admin book-on-behalf** runs through the same `/book` flow — default to **also blocked** for held-back councils (confirm with Dan).

### Out of scope (this build)
- EAS-on-old-Softr setup (Airtable/Softr config + 6 EAS staff logins) — old-system ops.
- EAS → Verco migration — future, once proven.
- Banner redesign + other UI/UX items — tracked separately.

---

## 5. Hardening (parallel)

An end-to-end test pass over the full booking surface — eligibility lookup → dual-limit pricing → paid/Stripe → capacity (incl. pooled areas) → cancellation cutoff. This is the literal answer to "not thoroughly tested," shortens the proof window before EAS migrates, and de-risks that migration.

---

## 6. Success criteria

- On `vvtest.verco.au`, **only MOS/COT/PEP addresses are bookable**; EAS + the 6 held-back councils resolve to "not yet available."
- `create-booking` **rejects an inactive-area booking even when called directly** (not just via the gated UI).
- Flipping one council's `is_active` brings it live **with no deploy**.
- E2E suite green across the full booking surface.

---

## 7. Open items

- Interim URL stays `vvtest` for now (Dan).
- Admin book-on-behalf for held-back councils: block or allow? (default: block)
- "Not yet available" copy — finalise with the UI/UX batch.
- Rollout `.docx` schedule — read 22/06, reconciled into the schedule below and Linear VER-268.

---

## 8. Stage-1 readiness — workstreams (scope expanded 22/06)

WMRC's rollout minutes (22/06) make Stage-1 scope the full acceptance punchlist, not just the gate. Tracked as **Linear epic VER-268** with seven workstreams:

| WS | Issue | Item | Size | Risk |
|----|-------|------|------|------|
| A | VER-269 | Staged go-live gate (`is_active`) | M | Med |
| B | VER-270 | Resident UI (terminology, bulk tile, rear verge, banner) | S | Low |
| C | VER-271 | Collection Dates page (filter, rename, ANC removal) | M | Low |
| D | VER-272 | Reports page (filters, waste-type breakdown) | M | Low-Med |
| E | VER-273 | MUD properties/auth-forms migration (run + verify) | S | Med |
| F | VER-274 | MUD bookings migration (build script) — long pole | L | Med-High |
| G | VER-275 | End-to-end hardening pass | M | — |

**Confirmed schedule:** Stage 1 (MOS/COT/PEP) 29 Jun · Stage 2 (EAS, FRE, VIN) 3 Aug · Stage 3 (SUB, VIC, SOP, FRE, CAM) 17 Aug. EAS bridges on old Softr from 1 Jul and migrates to new at Stage 2. Everything stays on old (`vergevalet.verco.au`) until its stage; final DNS cutover once all onboarded.

**Parallelization:** ~5 independent lanes (A booking flow + EF · B public UI · C collection-dates · D reports · E/F scripts) — good for worktree splitting.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 7 workstreams; 1 critical gap (WS-F); 3 content blockers |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

- **CRITICAL GAP:** WS-F (MUD bookings migration) — no script exists; silent bad/duplicate-booking risk on bad mapping or the `contacts` no-`UNIQUE(email)` gap (VER-256). Dry-run + per-council reconciliation mandatory before go-live.
- **OUTSIDE VOICE:** not run this pass (Codex skipped — consolidated review under deadline). Offer stands.
- **VERDICT:** ENG review complete — Stage-1 scope mapped to 7 workstreams (VER-269…275 under VER-268). Ready to implement once D1–D4 are resolved.

**UNRESOLVED DECISIONS:**
- D1 — MUD migration scoped to Stage-1 councils (MOS/COT/PEP) for 29 Jun: confirm
- D2 — WMRC's exact "Bulk → ___" wording (blocks WS-B item 1)
- D3 — accepted-bulk-items link URL (blocks WS-B item 2)
- D4 — ANC column removal is VV-only (Kwinana keeps it): confirm
