# Verco → HubSpot Sync — Design

Generated 2026-05-29 (office-hours → eng-review → research → live HubSpot inspection)
Repo: dmwaste/verco
Status: DIRECTION APPROVED — HubSpot side configurable now; EF build pending
**Supersedes:** [2026-05-28 WMRC HubSpot Integration](./2026-05-28-wmrc-hubspot-integration-design.md)

> The 2026-05-28 spec is **obsolete**. It assumed WMRC-*owned* HubSpot ingestion (HMAC
> webhooks, WMRC builds the endpoint), a generic `webhook_subscription`/`webhook_delivery`
> foundation, and `booking`/`contact` payload columns that don't exist in the schema. Reality
> (verified 2026-05-29): it's **D&M's own** HubSpot, fed today by **Make**, and bookings are
> **Orders**. This doc replaces it.

---

## 1. Decision log (how we got here)

1. Tech-agent recommendation: **stick with VoIPline → Teams → HubSpot**, not Allo/Attio.
2. HubSpot sync should be **Verco-sourced** (Kwinana is migrating Airtable → Verco) and
   **deeplink to Verco**, covering **contact + booking + service_ticket**.
3. Scope = **all bookings where D&M is the contractor** (contractor-scoped, not Kwinana-only) —
   so each client/area flows automatically as it lands in Verco.
4. Build approach = **a new Verco `sync-to-hubspot` Edge Function** (not Make, not the
   non-existent "WMRC HubSpot EF"), running **alongside** the legacy Make sync.

## 2. Verified reality (live inspection, 2026-05-29)

**D&M's HubSpot portal (account `442091910`, AP1, currency USD):**

| Object | Vol | Fed by | Notes |
|---|---|---|---|
| Contact (`0-1`) | 17,021 | Make ← Airtable | name + email + phone only; dedupe by email; no deeplink |
| **Order (`0-123`)** = booking | 20,835 | Make ← Airtable ("Master Run Sheet") | `hs_order_name`=ref (e.g. `SOP-53881`), `hs_external_order_status`="Booked", **`hs_external_order_url` = Airtable link**, `collection_date`, `address`. Multi-area (SOP/FRE-S…), not just Kwinana |
| Ticket (`0-5`) | 2,882 | Make ← Airtable ("Online Query") | "OQ-…" subjects; **Support Pipeline** (1 New / 2 Waiting on contact / 3 Waiting on us / 4 Closed); custom `query_type`, `phone_number`, `time_to_close`, empty `booking_ref` hook; no deeplink |

**No HubSpot Edge Function exists** (checked Verco repo, Verco Supabase, DM-Ops Supabase, no
DM-Ops checkout). The only CRM-sync EFs anywhere are **Attio** ones in DM-Ops
(`sync-contacts-to-attio`, `attio-sync-contact` v30, `attio-sync-ticket` v29,
`attio-inbound-webhook` v32) — **orphaned** by the HubSpot decision (decommission or repurpose;
§11).

**Key find:** HubSpot Orders have a native **`hs_external_order_url`** ("link to source
system"). The "deeplink to Verco" for bookings is just **swapping that field's value** from
the Airtable URL to the Verco admin URL — no new property needed.

## 3. Architecture

A new Verco Supabase Edge Function **`sync-to-hubspot`**, batch cron, **contractor-scoped**,
sourcing Verco (`contacts`, `booking`, `service_ticket`) and upserting into HubSpot via its
REST API. Mirrors the hardened `sync-to-attio` design (Attio office-hours + eng-review doc);
the DM-Ops `attio-sync-contact`/`-ticket` EFs are the structural reference to copy.

```
pg_cron (*/N)
   └── sync-to-hubspot EF (service role; advisory-locked)
         reads attio_sync_state-style cursor (updated_at, id) per entity
         WHERE contractor_id = <D&M> AND (updated_at,id) > cursor   LIMIT N
         │
         ▼  HubSpot batch upsert  [Contact: idProperty=email | Order/Ticket: idProperty=verco_*_id]  [no id writeback → no loop]
       Contact (0-1)      Order (0-123)        Ticket (0-5)
         │                                        │ booking_ref ← Verco booking ref
         └── associations: Order→Contact, Ticket→Contact (+Ticket→Order)

Make (Airtable → HubSpot) is RETIRED at the clean-break cutover. Post-cutover, ALL new
bookings go to Verco; the EF is the only feed.
```

**Clean break, not per-area coexistence (corrected post eng-review):** Airtable stops
receiving bookings at the cutover; Verco takes all new ones. So **no single booking is sourced
twice** — pre-cutover bookings are the historical Airtable Orders already in HubSpot;
post-cutover bookings are new Verco Orders via the EF. Make is decommissioned at the break (not
run in parallel per-area). Contractor-scope (all D&M) is therefore safe for bookings.

**The one thing that spans the break: Contacts (humans).** The 17k existing HubSpot Contacts
are email-keyed (Make). A resident who booked before AND after the break must NOT be
duplicated → **the EF dedupes Contacts by email** (HubSpot-native identity), not by
`verco_contact_id`. `verco_contact_id`/`verco_url` are still written as properties. Orders and
Tickets keep `verco_booking_id`/`verco_ticket_id` as their upsert keys (clean break = their
records never overlap the Airtable era).

## 4. Entity mapping (Verco → HubSpot) — schema-verified

| Verco (Supabase) | → HubSpot | Mapping | Deeplink (`verco.au`) |
|---|---|---|---|
| `contacts` | Contact `0-1` | firstname, lastname, email, phone ← `mobile_e164`; `verco_contact_id` (property, NOT key), `verco_url`. **Upsert key = email** (HubSpot-native; bridges the 17k Make-era contacts — eng-review Issue 2) | `/admin/contacts/{id}` |
| `booking` | Order `0-123` | `hs_order_name` ← `ref`; `hs_external_order_status` ← `status`; **`hs_external_order_url`** ← Verco deeplink; `collection_date` ← MIN(`collection_date.date`) via `booking_item`; `address` ← `eligible_properties.formatted_address`??`address` via `property_id`; amount ← Σ(`booking_item.unit_price_cents`×`no_services`); **`verco_booking_id`** (=`booking.id`, upsert key) | `/admin/bookings/{id}` |
| `service_ticket` | Ticket `0-5` | subject, content, `hs_pipeline_stage` ← `status` (map to Support Pipeline), `query_type`, `phone_number`, `time_to_close`; **`verco_ticket_id`** (upsert key), `verco_url`; populate `booking_ref` ← Verco booking ref | `/admin/tickets/{id}` |

Associations: Order→Contact, Ticket→Contact, Ticket→Order (via `booking_ref`).
Schema mapping verified against `src/lib/supabase/types.ts` — `ref` not `reference`, no
`booking.total_cents` (sum `booking_item`), no `booking.collection_date` column (join), address
via `eligible_properties`. (The 2026-05-28 spec's columns were fabricated; corrected here.)

### Status mappings (to confirm against live pipelines)
- **Order** `hs_external_order_status` is a free string → map Verco `booking_status`
  (Confirmed / Pending Payment / Scheduled / Completed / Cancelled / Non-conformance / Nothing
  Presented / Rebooked) to readable strings. No HubSpot pipeline needed for Orders.
- **Ticket** Support Pipeline stages (New / Waiting on contact / Waiting on us / Closed) ←
  Verco `service_ticket` status (Issued / Disputed / Under Review / Resolved / Rescheduled /
  Rebooked). Mapping table to be finalised against the real ticket statuses.

## 5. Scope — contractor-scoped

Filter every entity query by **D&M as contractor**:
`booking`/`service_ticket` carry `client_id`; `client` carries `contractor_id`; so join
`... WHERE client.contractor_id = <D&M contractor id>`. `contacts` via EXISTS(a booking under a
D&M-contractor client). Effectively all of Verco today (single contractor), but expressed as
contractor scope so new clients/areas auto-include with no code change.

## 6. Upsert & dedupe — simpler than Attio

HubSpot supports **upsert by `idProperty`** (a custom unique property) on the batch upsert API.
So `verco_contact_id` / `verco_booking_id` / `verco_ticket_id` are the dedupe keys directly —
**HubSpot owns the match; we never store HubSpot's record id back in Verco.** That means the
Attio infinite-re-sync-loop (Issue 1 from the Attio eng-review, caused by the `updated_at`
writeback) **does not exist here**. No reverse-link columns, no conditional writeback. Cleaner.

## 7. Transport details (carried from the Attio eng-review)

- **Compound `(updated_at, id)` cursor** per entity — no same-timestamp row skips.
- **Self-limited** N rows/run; backlog (and any backfill) drains across cron ticks → never
  approaches the EF wall-clock limit.
- **`pg_try_advisory_lock`** at EF start → no overlapping runs.
- **HubSpot 429 / rate limits** → stop batch, hold cursor, return 500, resume next tick.
- **Keyset index** `(updated_at, id)` on `contacts` / `booking` / `service_ticket`.
- **Pure mapping logic** in `src/lib/hubspot/` (Vitest), EF imports it — mirrors the
  `src/lib/pricing` pattern; the future-proof home for field mapping + status maps.
- Cron returns **HTTP 500 on any per-row failure** (no silent 200) — CLAUDE.md §11.

## 8. HubSpot-side configuration (I can start now — connected)

Create custom properties (mark the id ones **unique** for `idProperty` upsert):
- Contact: `verco_contact_id` (unique), `verco_url`
- Order: `verco_booking_id` (unique), `verco_url` *(or reuse `hs_external_order_url`)*
- Ticket: `verco_ticket_id` (unique), `verco_url`
- **Verify the property-creation path** — the connected HubSpot MCP exposes record + read
  tools; creating *property definitions* (and marking unique) may be UI/admin or need a
  different API. Confirm before relying on programmatic creation.

## 9. Open items / build-time verifies

1. **Property creation method** (MCP vs HubSpot UI) — §8.
2. **`idProperty` upsert** confirmed against the created unique properties.
3. **Ticket status map** finalised against the live Support Pipeline + Verco service_ticket states.
4. **D&M contractor id** in Verco (for the scope filter) — query Verco.
5. **Currency:** HubSpot account is USD; booking amounts are AUD. Either add AUD as a HubSpot
   currency or treat `amount` as cosmetic (most verge bookings are $0). Decide.
6. **Kwinana-in-Verco status** — is Kwinana data actually in Verco yet, or is this design-ahead
   of the migration? The EF can't sync what isn't in Verco.

## 10. Build sequence

1. HubSpot: create the custom properties (§8); confirm `idProperty` upsert.
2. Verco: `src/lib/hubspot/` pure mappers + status maps (Vitest 100%); `hubspot_sync_state`
   cursor table + keyset indexes migration.
3. `sync-to-hubspot` EF: advisory lock → cursor read → contractor-scoped ≤N-row queries →
   HubSpot upsert (idProperty) → associations → cursor advance → 500-on-failure/429. Mocked
   HubSpot fetch in tests (mirror the Attio test strategy).
4. Set EF secret `HUBSPOT_ACCESS_TOKEN`; pg_cron schedule.
5. Smoke: a Verco Kwinana booking → Contact + Order + Ticket in HubSpot within a tick, with
   `hs_external_order_url` → live Verco, associations correct, no duplicates.
6. Backfill: cursor at epoch; cron drains; watch for 429s.

## 11. Cleanup flagged

The DM-Ops Attio EFs (`sync-contacts-to-attio`, `attio-sync-contact`, `attio-sync-ticket`,
`attio-inbound-webhook`) are **orphaned** by the HubSpot decision but still ACTIVE. Decommission
(or repurpose the structure for `sync-to-hubspot`) so they don't run/cost/confuse.

## 11a. Engineering Review (2026-05-29)

Reviewed against live HubSpot + live Verco data. Two findings, both resolved into the spec.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | P1 | Blanket contractor-scope would double-feed any client in BOTH Verco and Airtable-Make (Verge Valet is, today) | **Clean break** confirmed (Airtable retired at cutover, Verco takes all new) → contractor-scope safe for bookings. §3 corrected from "per-area coexistence" to clean break. |
| 2 | P1 | EF keying Contacts on `verco_contact_id` would duplicate returning residents (17k existing contacts are email-keyed from Make) | **Dedupe Contacts by email** (HubSpot-native); Orders/Tickets keep `verco_*_id`. §4 updated. |
| 3 | — | `idProperty` upsert on a unique custom property unverified on this STANDARD account (Attio-lesson echo) | **Build-gate** (§9): verify before EF build; Make already upserts 20k Orders so capability exists — confirm the EF can use `verco_*_id` as key. |

Verified facts: Verco `booking` holds Verge Valet (9) + Kwinana (3) under D&M; HubSpot has
17,021 Contacts / 20,835 Orders / 2,882 Tickets, all Make-fed; Vitest + Playwright present.

### Test Plan (Vitest; HubSpot fetch MOCKED; target 100% on pure logic)
- **Pure `src/lib/hubspot/`:** `mapContactToHubspot` (email present, verco props), `mapBookingToOrder`
  (ref / status string / `hs_external_order_url`=Verco / MIN collection_date / Σ amount / address
  fallback), `mapTicketToHubspotTicket` (booking_ref link), `bookingStatusMap` (all 8 statuses),
  `ticketStatusMap` (→ Support Pipeline 1/2/3/4; unmapped→default), cursor compare `(updated_at,id)`.
- **EF integration (mocked):** Contact upsert **by email** → returning resident UPDATES not dups
  (Issue 2); Order upsert by `verco_booking_id` idempotent; Ticket upsert + `booking_ref`→Order
  association; contractor scope; 429 → hold cursor + 500; per-row failure → 500; advisory lock
  no-ops 2nd run; associations Order→Contact, Ticket→Contact.
- **Build-gate (live, not CI):** `idProperty` batch-upsert works on a unique custom property for
  Orders (0-123) + Tickets.
- **Manual smoke:** deferred until a client is live in Verco post-cutover (design-ahead).

### Failure modes
| Codepath | Failure | Test | Handling | Visible? |
|---|---|---|---|---|
| Contact upsert | returning resident duplicated | Issue-2 test | email idProperty | was silent → guarded |
| Order/Ticket upsert | re-run duplicates | idempotency test | verco_*_id idProperty | guarded |
| HubSpot 429 | sync stalls | integration test | hold cursor + 500 | pg_cron logs 500 |
| Overlapping runs | cursor race | advisory-lock test | `pg_try_advisory_lock` | guarded |
| idProperty unsupported on tier | upsert fails at build | build-gate verify | — | caught pre-ship |

No critical gaps (every silent failure has a test + handling).

### Parallelization
Lane A (migration: `hubspot_sync_state` + keyset indexes) ∥ Lane B1 (`src/lib/hubspot/` pure
module + Vitest, no DB dep). Then B2 (EF wiring) after both. HubSpot property config (UI) is
independent and gates the live smoke only.

### Implementation Tasks
- [ ] **T1 (P1, human ~2h / CC ~20min)** — sync-to-hubspot EF — contractor-scoped cursor sync + batch upsert
  - Surfaced by: Architecture (scope + clean break)
  - Files: `supabase/functions/sync-to-hubspot/index.ts`
  - Verify: integration test (mocked HubSpot) — contractor scope, idempotent upsert
- [ ] **T2 (P1, human ~30min / CC ~5min)** — Contact upsert keyed on email (not verco_contact_id)
  - Surfaced by: Issue 2 — returning-resident duplication
  - Files: `supabase/functions/sync-to-hubspot/index.ts`, `src/lib/hubspot/`
  - Verify: test — existing email-keyed contact UPDATED, not duplicated
- [ ] **T3 (P2, human ~1h / CC ~10min)** — `src/lib/hubspot/` pure mappers + status maps (Vitest 100%)
  - Surfaced by: Code Quality (testability/DRY)
  - Files: `src/lib/hubspot/*.ts`, `src/__tests__/hubspot/*`
- [ ] **T4 (P2, human ~30min / CC ~5min)** — migration: `hubspot_sync_state` + keyset `(updated_at,id)` indexes
  - Surfaced by: Performance + transport
  - Files: `supabase/migrations/<ts>_hubspot_sync.sql`
- [ ] **T5 (P1, human ~20min / CC ~5min)** — BUILD-GATE: verify HubSpot unique-property + idProperty upsert (Orders/Tickets)
  - Surfaced by: Issue 3 (Attio-lesson echo)
  - Files: HubSpot (UI/admin) + a throwaway upsert test
- [ ] **T6 (P2, human ~20min / CC ~5min)** — create HubSpot custom properties (verco_*_id unique, verco_url) + decommission orphaned DM-Ops Attio EFs
  - Surfaced by: §8 + §11
  - Files: HubSpot UI; DM-Ops Supabase

## 12. References

- Superseded: `2026-05-28-wmrc-hubspot-integration-design.md`
- Pattern source: hardened Attio design (office-hours + eng-review, PR #117) + DM-Ops
  `attio-sync-contact`/`-ticket` EFs
- Live HubSpot state inspected via HubSpot MCP (portal 442091910), 2026-05-29
- Legacy sync: Make (Airtable → HubSpot), `hs_object_source_detail_1: "Make"`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | n/a (tech-agent set direction) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 issues, 0 critical gaps, both resolved + 1 build-gate |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (backend sync, no UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED — plan ready to implement once a client is live in Verco (post-clean-break migration). Build-gate before EF: verify HubSpot `idProperty` upsert on a unique custom property (§9 / T5). No design/CEO review needed (backend sync, no UI; strategy set by tech-agent). Decisions: contractor-scope safe under clean break; Contacts dedupe by email; Orders/Tickets by `verco_*_id`.
