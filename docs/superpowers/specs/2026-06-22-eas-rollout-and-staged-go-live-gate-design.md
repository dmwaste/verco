# Verge Valet Staged Go-Live & EAS Rollout — Decision + Gate Design

**Date:** 2026-06-22
**Status:** Strategy approved (Dan) — implementation plan to follow
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
- Confirm against the rollout `.docx` schedule (couldn't read it — binary attachment; pending Dan dropping it somewhere readable).
