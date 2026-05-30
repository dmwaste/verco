<!-- /autoplan restore point: /Users/danieltaylor/.gstack/projects/dmwaste-verco/claude-serene-bose-fc8767-autoplan-restore-20260529-205949.md -->
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

A new Verco Supabase Edge Function **`sync-to-hubspot`**, batch cron, **per-client-allowlist
scoped** (§5), sourcing Verco (`contacts`, `booking`, `service_ticket`) and upserting into HubSpot
via its REST API. Closest **in-repo** precedent to copy is **`nightly-sync-to-dm-ops`** (Verco's
only existing service-role outbound sync); the DM-Ops `attio-sync-*` EFs are a secondary cross-repo
reference. NB: the cursor table and `pg_try_advisory_lock` are **net-new to Verco** (no existing
`*_sync_state` table or advisory-lock usage) — write the lock release carefully (all return paths).

```
pg_cron (*/N) ──net.http_post (pg_net: FIRE-AND-FORGET; HTTP status lands async, NOT in cron.job_run_details)──▶
   sync-to-hubspot EF (service role; bearer-checked; advisory-locked, released on every return path)
     per entity: cursor (updated_at, id) in hubspot_sync_state
     WHERE booking.contractor_id=<D&M> AND client_id=ANY(<allowlist>) AND (updated_at,id) > cursor  LIMIT N
     │
     ▼  ORDERED per run so associations resolve (parent before child):
     1. Contacts (idProperty=email)            ──▶ Contact 0-1
     2. Orders   (idProperty=verco_booking_id) ──▶ Order 0-123  ──assoc──▶ Contact
     3. Tickets  (idProperty=verco_ticket_id)  ──▶ Ticket 0-5   ──assoc──▶ Contact (+Order when booking_id)
        parent-not-yet-synced → do NOT advance child cursor; retry next tick (common on epoch backfill)
     │  [no HubSpot id written back to Verco → no updated_at bump → no re-sync loop]
     ▼  persist run outcome → sync_log {entity, rows_synced, cursor_advanced, last_error, pii_rows}
        (the VISIBLE failure signal — pg_net swallows the HTTP 500) + hubspot_sync_state.last_run_at/last_error

Make (Airtable → HubSpot) is RETIRED per-client as each council cuts over (not one global instant break).
```

**Per-client cutover, made safe structurally (revised post /autoplan):** the original "clean
break = blanket contractor-scope is safe" assumed a single instant cutover across all councils.
In reality each council migrates on its own timeline (Verge Valet is in BOTH Verco and
Airtable-Make today). So the EF scopes to a **per-client allowlist** (§5): a `client_id` only
enters the allowlist once *its* Airtable→Verco cutover completes and *its* Make feed is retired.
That guarantees **no single booking is sourced twice** by construction — not by trusting a global
break to have happened. Pre-cutover bookings are the historical Airtable Orders already in HubSpot;
post-cutover (allowlisted) bookings are new Verco Orders via the EF.

**The one thing that spans the break: Contacts (humans).** The 17k existing HubSpot Contacts
are email-keyed (Make). A resident who booked before AND after the break must NOT be
duplicated → **the EF dedupes Contacts by email** (HubSpot-native identity), not by
`verco_contact_id`. `verco_contact_id`/`verco_url` are still written as properties. Orders and
Tickets keep `verco_booking_id`/`verco_ticket_id` as their upsert keys (clean break = their
records never overlap the Airtable era).

## 4. Entity mapping (Verco → HubSpot) — schema-verified

| Verco (Supabase) | → HubSpot | Mapping | Deeplink (`verco.au`) |
|---|---|---|---|
| `contacts` | Contact `0-1` | firstname, lastname, email, phone ← `mobile_e164`; `verco_contact_id` (property, NOT key), `verco_url`. **Upsert key = email** (HubSpot-native; bridges the 17k Make-era contacts — eng-review Issue 2) | **dropped (TD1)** — no `/admin/contacts` page exists; the Order/Ticket deeplinks carry the value |
| `booking` | Order `0-123` | `hs_order_name` ← `ref`; `hs_external_order_status` ← mapped `booking_status` (**all 10**, incl. `Submitted`, `Missed Collection`); **`hs_external_order_url`** ← Verco deeplink; `collection_date` ← MIN(`collection_date.date`) via `booking_item` as a **date-only `YYYY-MM-DD` string** (AWST; account is US/Eastern — never a timestamp, avoids off-by-one); `address` ← `eligible_properties.formatted_address ?? address` via `property_id`; amount **omitted (TD2)** — never write AUD into the native USD `amount` (§9.4); **upsert key = native `hs_external_order_id`** = `booking.id` (VER-235 — no custom Order property needed; `verco_url` optional) | `/admin/bookings/{id}` |
| `service_ticket` | Ticket `0-5` | subject ← `subject`; content ← **`message`**; `query_type` ← **`category`** (`ticket_category` enum); `phone_number` ← joined **`contacts.mobile_e164`** (no phone on the ticket); `time_to_close` ← computed **`closed_at − created_at`** (null while open); `hs_pipeline_stage` ← mapped `ticket_status` (see below); **`verco_ticket_id`** (=`service_ticket.id`, upsert key), `verco_url`; `booking_ref` ← Verco booking `ref` when `booking_id` set | `/admin/service-tickets/{id}` |

Associations: Order→Contact, Ticket→Contact, Ticket→Order (when `booking_id` set). **Ordering matters** — see §3 (parent before child).
Schema **re-verified** against `src/lib/supabase/types.ts` (2026-05-29 /autoplan): `booking.ref`,
`booking.contractor_id` (direct, no client join), no `booking.total_cents`, collection_date via
`booking_item.collection_date_id`, address via `eligible_properties`. **Corrected**: the original
§4 mapped phantom ticket columns (`content`/`query_type`/`phone_number`/`time_to_close` don't exist
→ `message`/`category`/joined `mobile_e164`/derived), conflated `service_ticket` with the NCN/NP
state machine for status (real `ticket_status` enum below), and used non-existent deeplink routes.

### Status mappings (verified enums; confirm pipeline stage IDs against the live Support Pipeline)
- **Order** `hs_external_order_status` is a free string → map the **10** `booking_status` values
  (`Pending Payment / Submitted / Confirmed / Scheduled / Completed / Cancelled / Non-conformance /
  Nothing Presented / Rebooked / Missed Collection`) to readable strings + explicit default. No HubSpot pipeline needed for Orders.
- **Ticket** Support Pipeline (New / Waiting on contact / Waiting on us / Closed) ← the real
  `ticket_status` enum: `open`→1 New, `waiting_on_customer`→2 Waiting on contact, `in_progress`→3
  Waiting on us, `resolved`/`closed`→4 Closed; unmapped→default. (NOT the NCN/NP states — those are
  the `non_conformance_notice` table, a different domain.)

## 5. Scope — per-client allowlist within D&M contractor (premise-gate decision, 2026-05-29)

**Structural, not temporal.** The original "blanket contractor-scope, safe because clean break"
relied on a perfectly-synchronised cutover across multiple councils on different migration
timelines (Verge Valet is live in BOTH Verco and Airtable-Make *today*). Replaced with a
**per-client allowlist** flipped on at each council's cutover — coexistence is safe *by
construction*, no dependency on an instant break.

Predicates (schema-verified):
- **`booking`** carries `contractor_id` **directly** (no `client` join): `WHERE booking.contractor_id = <D&M> AND booking.client_id = ANY(<allowlist>)`.
- **`service_ticket`** carries `client_id` (no `contractor_id`) → join `client.contractor_id` + `client_id = ANY(<allowlist>)`.
- **`contacts`** carry neither → `EXISTS(D&M+allowlisted booking) OR EXISTS(D&M+allowlisted service_ticket)`. The OR matters: "Online Query" enquirers have tickets but no booking and must not be dropped.

New clients still auto-include with no code change once added to the allowlist.

## 6. Upsert & dedupe — simpler than Attio

HubSpot supports **upsert by `idProperty`** on the batch upsert API. Dedupe keys (refined by VER-235):
**Contact = `email`** (native), **Order = `hs_external_order_id`** (native external-id field = `booking.id`;
no custom property), **Ticket = `verco_ticket_id`** (custom unique — no native external-id on tickets).
**HubSpot owns the match; we never store HubSpot's record id back in Verco.** That means the
Attio infinite-re-sync-loop (Issue 1 from the Attio eng-review, caused by the `updated_at`
writeback) **does not exist here**. No reverse-link columns, no conditional writeback. Cleaner.
⚠️ idProperty on a *custom unique* property (the Ticket path) is unverified on STANDARD tier → §9.1 gate.

## 7. Transport details (carried from the Attio eng-review)

- **Compound `(updated_at, id)` cursor** per entity — no same-timestamp row skips.
- **Self-limited** N rows/run; backlog (and any backfill) drains across cron ticks → never
  approaches the EF wall-clock limit.
- **`pg_try_advisory_lock`** at EF start → no overlapping runs. **Release on EVERY return path**
  (success, 429, per-row error) or use a txn-scoped lock — net-new pattern in Verco, easy to leak.
- **HubSpot 429 / rate limits** → stop batch, hold cursor, persist a `sync_log` row, return.
- **Keyset index** `(updated_at, id)` on `contacts` / `booking` / `service_ticket`; also verify
  `booking.contact_id` + `service_ticket.contact_id` are indexed (the contacts EXISTS predicate).
- **Pure mapping logic** in `src/lib/hubspot/` (Vitest), EF imports it — mirrors the
  `src/lib/pricing` pattern; the future-proof home for field mapping + status maps.
- **Visibility (corrected — F4):** the cron invokes the EF via `net.http_post` (pg_net), which is
  **fire-and-forget** — the HTTP 500 lands asynchronously in `net._http_response` and is **invisible**
  in `cron.job_run_details`. So per-row failure must be recorded in a **`sync_log`** row the EF writes
  (entity, rows_synced, cursor_advanced, last_error). Keep the 500 for correctness, but the *visible*
  signal is the row, not the status code. (CLAUDE.md §11's "pg_cron sees the status" is imprecise for the pg_net path.)
- **Audit (F10):** this EF exports resident PII (name/email/`mobile_e164`) to a third party on a cron.
  The `sync_log` row doubles as the PII-export audit trail (rows exported, when) — CLAUDE.md §21.
- **Caller guard (F11):** the EF URL is public → verify the incoming bearer == service-role/cron secret
  before any work, so an attacker can't POST-trigger a PII export. (`nightly-sync-to-dm-ops` lacks this — don't copy that gap.)
- **Association idempotency (F8):** HubSpot association-create is a no-op if it already exists — safe on re-run; assert it in the build-gate rather than assume.

## 8. HubSpot-side configuration (I can start now — connected)

**Property-creation path — RESOLVED (VER-235, 2026-05-29):** the connected HubSpot MCP is
**read-only for property *definitions*** (`get_properties`/`search_properties` read; `manage_crm_objects`
only writes *records* + associations, update-by-`objectId`, **no `idProperty` param**). So properties
are created in the **HubSpot UI/admin**, and the idProperty batch-upsert is a **direct REST call**
the EF makes (not the MCP).

**Live property findings (VER-235 read-only pass):**
- **Order** has native **`hs_external_order_id`** ("unique id in an external system") — currently **empty**
  on the 20,835 Make-fed Orders (Make keys on `hs_order_name`). **Use it as the Order idProperty
  (`hs_external_order_id` = `booking.id`) — no custom Order property needed.** `hs_order_name`←`ref`,
  `hs_external_order_url`←Verco deeplink (currently Airtable links), `hs_external_order_status`←status. ✅ all native.
- **Ticket** has `booking_ref` (custom, already exists, empty) for the Ticket→Order link, but **no native
  external-id field** → needs a custom unique **`verco_ticket_id`**.
- **Contact** dedupes by **email** (native) → `verco_contact_id` is a NON-unique reference prop (not a key).

Properties to create in the UI (minimised):
- Ticket: **`verco_ticket_id` (unique)** + `verco_url`
- Order: `verco_url` *(or reuse `hs_external_order_url`)* — **no custom unique key needed** (native `hs_external_order_id`)
- Contact: `verco_contact_id` (NOT unique), `verco_url`. *(Contact deeplink dropped — TD1.)*

## 9. Open items / build-time verifies

1. **TASK-ZERO build-gate — CLEARED (VER-235, 2026-05-29):**
   - ✅ Property-creation path = **UI-only** (MCP read-only for defs — §8). MCP can't run idProperty
     upsert (no `idProperty` param) → the live test is a **direct REST call** (`POST /crm/v3/objects/{type}/batch/upsert`) with `HUBSPOT_ACCESS_TOKEN`.
   - ✅ `verco_*` props absent; Order native `hs_external_order_id` is free → **Orders need no custom key**.
   - ✅ **STANDARD tier supports a custom UNIQUE property** — verified in the live create-property UI
     ("Require unique values *(0 of 10)*" quota present) and proven by **creating `verco_ticket_id` (unique,
     single-line text) on Tickets**. This is the prerequisite the custom-unique idProperty path (Tickets) needed.
   - ↘ **Downgraded to build-time smoke (not a blocker):** the live batch `idProperty` upsert *call* itself —
     run it against `hs_external_order_id` (Orders) + `verco_ticket_id` (Tickets) when the EF is wired with its
     real `HUBSPOT_ACCESS_TOKEN` (which doesn't exist yet). idProperty-upsert-on-a-unique-prop is documented
     standard behaviour; the tier-gated prerequisite is now confirmed, so residual risk is low. (Public-API
     token path is OAuth-gated post HubSpot's private-apps→legacy-apps migration — not worth minting just for this.)
2. **Ticket status map — CONFIRMED live (VER-235):** Support Pipeline = `hs_pipeline` **"0"**; stages
   `hs_pipeline_stage` = **1** New / **2** Waiting on contact / **3** Waiting on us / **4** Closed. Map:
   `open`→1, `waiting_on_customer`→2, `in_progress`→3, `resolved`/`closed`→4; unmapped→default. (Source enum
   is the real `ticket_status`, §4 — not NCN/NP states.)
3. **D&M contractor id** in Verco (scope filter) — query Verco. Plus the initial **client allowlist** (§5).
4. **Currency — DECIDED (TD2 = omit):** account is USD-only (no AUD currency, verified). Do **not**
   write AUD into the native USD `amount` (silent ~1.5× corruption in any HubSpot revenue report).
   **Omit `amount` entirely** (not needed for the call-centre lookup; most verge bookings are $0). If a
   figure is ever needed, add a labelled `verco_amount_aud` custom property — never the native field.
5. **Timezone (F5):** account is **US/Eastern**, data is **AWST (UTC+8)**. Write `collection_date` as a
   date-only `YYYY-MM-DD` string (never a timestamp) and verify it renders correctly in the AP1 UI —
   an off-by-one date breaks the exact "when's my collection" call this exists to serve. Add to build-gate.
6. **Client-live-in-Verco status** — Kwinana (and others) may not be in Verco yet. **Design-ahead is
   accepted, but build-ahead is not:** build the `src/lib/hubspot/` mappers + Vitest now; **gate the EF
   wiring + the live smoke + any "cleared" verdict on the first real client being live post-cutover.**

## 10. Build sequence

0. **TASK-ZERO spike (gate, ~30min):** create `verco_*_id` unique props; prove `idProperty`
   batch upsert dedupes + association idempotency on STANDARD tier; confirm date-only render. **If this
   fails the whole dedup model collapses (back to read-then-match) — do NOT build the EF until it clears.**
1. Verco: `src/lib/hubspot/` pure mappers + status maps (Vitest 100%, real enums) — buildable now,
   no client-live dependency; `hubspot_sync_state` cursor table + `sync_log` use + keyset indexes migration.
2. `sync-to-hubspot` EF: bearer-check → advisory lock → cursor read → allowlist-scoped ≤N-row queries →
   ORDERED upsert (Contacts→Orders→Tickets, idProperty) → associations (parent-before-child; lag-one-tick
   tolerated) → cursor advance → persist `sync_log` row (visible signal) → release lock. Mocked HubSpot fetch in tests.
3. Set EF secret `HUBSPOT_ACCESS_TOKEN`; pg_cron schedule (pg_net).
4. **Gate on first real client live in Verco** (post-cutover) — then add its `client_id` to the allowlist.
5. Smoke: that client's booking → Contact + Order + Ticket within a tick; `hs_external_order_url` → live
   Verco; associations correct; no dupes; `sync_log` row written.
6. Backfill: cursor at epoch; cron drains; watch 429s + the `sync_log` error column.

## 11. Cleanup flagged

The DM-Ops Attio EFs (`sync-contacts-to-attio`, `attio-sync-contact`, `attio-sync-ticket`,
`attio-inbound-webhook`) are **orphaned** by the HubSpot decision but still ACTIVE. Decommission
(or repurpose the structure for `sync-to-hubspot`) so they don't run/cost/confuse.

## 11a. Engineering Review (2026-05-29) — *partially superseded by §11b /autoplan*

> ⚠️ This manual eng-review's "ENG CLEARED" verdict was **over-stated**. The /autoplan dual-voice
> pass (§11b) found its "schema-verified" §4 mapping was wrong in 4 places (phantom ticket columns,
> wrong status enum, dead deeplink routes, 8-vs-10 statuses) and its "pg_cron logs 500" visibility
> claim is mechanically false (pg_net is fire-and-forget). Treat §11b + the corrected §3–§10 as
> canonical. This block is retained as the review trail.

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

### Implementation Tasks (revised by /autoplan — Linear VER-235..240 need updating to match)
**Build order: T5/T6 (gate) → T3+T4 → T1/T2. T5 is now TASK ZERO.**
- [ ] **T5 → T0 (P1, BUILD-GATE, human ~30min / CC ~5min)** — verify `idProperty` batch upsert **+ association
  idempotency + date-only render** on STANDARD tier. **Blocks all EF code.** (Linear VER-235)
  - Files: HubSpot (UI/admin) + a throwaway upsert/assoc test
- [ ] **T6 (P2, human ~20min / CC ~5min)** — create HubSpot custom props (`verco_*_id` unique, `verco_url`) +
  decommission orphaned DM-Ops Attio EFs (do the decommission **now**, decoupled — pure liability). (VER-236)
  - Files: HubSpot UI; DM-Ops Supabase
- [ ] **T3 (P2, human ~1h / CC ~10min)** — `src/lib/hubspot/` pure mappers + status maps (Vitest 100%,
  **REAL enums** — 10 booking statuses, 5 ticket statuses; corrected ticket source columns). Buildable now. (VER-237)
  - Files: `src/lib/hubspot/*.ts`, `src/__tests__/hubspot/*`
- [ ] **T4 (P2, human ~30min / CC ~5min)** — migration: `hubspot_sync_state` cursor + `sync_log` use +
  keyset `(updated_at,id)` indexes (and verify `*.contact_id` indexes for the EXISTS predicate). (VER-238)
  - Files: `supabase/migrations/<ts>_hubspot_sync.sql`
- [ ] **T1 (P1, human ~2h / CC ~20min)** — `sync-to-hubspot` EF: **allowlist**-scoped cursor sync, **ORDERED**
  upsert (Contacts→Orders→Tickets), associations w/ parent-before-child, **bearer guard**, **`sync_log`
  visibility+PII audit**, advisory-lock release on all paths. Gated on first client live in Verco. (VER-239)
  - Files: `supabase/functions/sync-to-hubspot/index.ts`
  - Verify: integration tests (mocked HubSpot) — allowlist scope, idempotent upsert, ordering, 429, lock
- [ ] **T2 (P1, human ~30min / CC ~5min)** — Contact upsert keyed on **email** (not `verco_contact_id`);
  contacts EXISTS over (booking OR ticket). (VER-240)
  - Files: `supabase/functions/sync-to-hubspot/index.ts`, `src/lib/hubspot/`
  - Verify: returning email-keyed contact UPDATED not duplicated; ticket-only contact included
- [ ] **T7 (P2, human ~30min / CC ~10min) — NEW** — `sync_log` run-outcome row (entity, rows, cursor, error,
  pii_rows) = the visible failure signal (pg_net swallows the 500) + PII-export audit. *(cross-phase theme)*
  - Files: `supabase/functions/sync-to-hubspot/index.ts`, migration
- [x] **T8 (TD1) — DECIDED: drop the contact deeplink** (no `/admin/contacts` page; Order/Ticket deeplinks carry the value).
- [x] **T9 (TD2) — DECIDED: omit native `amount`** (USD acct; use `verco_amount_aud` only if a figure is ever needed).
  - Files: HubSpot UI; DM-Ops Supabase

## 11b. /autoplan Review (2026-05-29) — CEO + Eng, dual-voice (subagent-only; Codex unavailable)

Pipeline: CEO → Eng (Design + DX skipped — backend sync, no UI, no external developer surface).
One blind Claude subagent per phase (Codex binary absent). Both subagents inspected live HubSpot +
`types.ts` and challenged the spec's own "ENG CLEARED" optimism. **9 CEO + 11 Eng findings.**

**Premise gate (Dan, not auto-decided):** *Confirm EF + harden* — keep the bespoke EF (tech-agent's
call), AND (1) idProperty spike → task-zero, (2) per-client allowlist instead of blanket
contractor-scope, (3) currency/timezone decided in-spec. (Rejected: bake-off-Make-first, confirm-as-is.)

**Live facts surfaced:** HubSpot account `442091910` is **STANDARD tier, USD-only (no AUD currency),
US/Eastern timezone**; **zero `verco_*` properties exist yet** (idProperty model 100% unverified).

**CEO findings:** F1 build may be migration-continuity not a capability gap (call-centre works today
via Make) · F2 Make-repoint vs bespoke-EF never compared (resolved at gate: EF + harden) · F3 "clean
break" → **structural per-client allowlist** (applied §5) · F4 currency not cosmetic (applied §9.4) ·
F5 **timezone** off-by-one (applied §4/§9.5) · F6 idProperty spike → task-zero (applied §10) · F7
EF↔Make vocab drift → canonicalise strings in `src/lib/hubspot/` · F8 build-ahead-of-reality → mappers
now, EF gated on live client (applied §9.6) · F9 decommission orphaned Attio EFs now (T6).

**Eng findings (schema-verified by me):** F1 CRIT phantom ticket columns → `message`/`category`/joined
`mobile_e164`/derived (applied §4) · F2 CRIT wrong status enum (NCN/NP ≠ `service_ticket`) → real
`ticket_status` (applied §4) · F3 dead deeplinks → `/admin/service-tickets/{id}`, no `/admin/contacts`
(applied §4, `[GATE-TD1]`) · F4 **pg_net fire-and-forget → 500 invisible**, use `sync_log` (applied
§3/§7, T7) · F5 association parent-before-child ordering + missing-parent handling (applied §3) · F6
8→**10** booking statuses (applied §4) · F7 `booking.contractor_id` direct + ticket-only contacts
(applied §5) · F8 association idempotency + currency gate (applied §7/§9) · F9 no `attio_sync_state`
in Verco; advisory-lock release on all paths (applied §3/§7) · F10 **PII-export audit** via `sync_log`
(applied §7, T7) · F11 caller bearer guard on the public EF (applied §7).

**Cross-phase theme:** *visibility of silent failure* flagged independently in BOTH phases (CEO F3
drift / Eng F4+F10) → the `sync_log` run-outcome row is now a must-have (observability + PII audit), T7.

### Decision Audit Trail
| # | Phase | Decision | Class | Principle | Rationale |
|---|---|---|---|---|---|
| 1 | CEO 0C-bis | Approach A (bespoke EF) over B (repoint Make) / C (contacts-only) | auto | P1+P5 | owned, tested, observable; B = no-test no-code; C loses context |
| 2 | CEO 0D | E1 sync observability (structured `sync_log`) → in scope | auto | P2 | blast-radius, <5 files, no infra; observability = scope |
| 3 | CEO 0D | E2 reconciliation/drift check → TODOS | auto | P3 | valuable at cutover but separate codepath |
| 4 | CEO 0D | E3 two-way sync → defer | auto | P3 | roadmap, out of scope |
| 5 | CEO gate | Build-vs-reuse: **Confirm EF + harden** | **user** | premise | Dan's call; absorbs F2/F3/F6 risk, keeps tech-agent direction |
| 6 | Eng F1 | Rewrite ticket mapping to real columns | auto | P5 | phantom columns don't compile |
| 7 | Eng F2 | Correct ticket status map to real enum | auto | P5 | NCN/NP is a different table |
| 8 | Eng F3 | Fix ticket deeplink; contact deeplink → `[GATE-TD1]` | auto+taste | P5 | route verified; contacts page absent → Dan decides |
| 9 | Eng F4/F10 | `sync_log` run-outcome row (visibility + PII audit) | auto | P1 | pg_net swallows 500; compliance |
| 10 | Eng F5 | Ordered upsert + parent-before-child + lag-one-tick | auto | P5 | associations need both records |
| 11 | Eng F6 | Map all 10 booking statuses + default | auto | P1 | completeness |
| 12 | Eng F7 | `booking.contractor_id` direct; contacts EXISTS booking OR ticket | auto | P5 | schema-accurate; don't drop enquirers |
| 13 | Eng F11 | Caller bearer guard on EF | auto | P1 | public URL → PII-export protection |
| 14 | CEO F4 / Eng F8 | Currency → `[GATE-TD2]` (default: omit `amount`) | taste | P5 | USD acct + AUD = silent corruption; Dan decides |

**NOT in scope (deferred):** two-way HubSpot→Verco sync (roadmap); reconciliation/drift cron (TODOS);
`/admin/contacts/{id}` page (TD1 = drop deeplink); native `amount` (TD2 = omit); cross-client benchmarking (PRD-excluded).

**What already exists (reuse):** `nightly-sync-to-dm-ops` (in-repo service-role sync skeleton);
`src/lib/pricing/calculate.ts` (pure-logic+Vitest pattern); DM-Ops `attio-sync-*` (cross-repo transport ref);
`hs_external_order_url` (native deeplink field); Make already proves HubSpot upsert capability.

## 11c. Focused Eng Review (2026-05-30) — pre-build, against the as-built foundation

Run after the foundation shipped (`src/lib/hubspot/*` + the VER-238 migration on prod) and the
HubSpot props were created (VER-235/236). Scope: eng-only (CEO/premise locked §11b; no UI; DX n/a).
Reviewed the EF build plan against what actually got built.

**As-built confirmed (no drift):** mappers match the corrected §4 (email-key contacts with null-email
skip; `hs_external_order_id` orders; real ticket columns content←message / query_type←category /
phone_number / time_to_close; omit-amount TD2; drop-contact-deeplink TD1; 10 booking statuses passthrough;
ticket pipeline `0`, stages 1-4). VER-238 migration correct: keyset `(updated_at,id)` indexes present;
`contact_id` indexes pre-exist (`idx_booking_contact`, `idx_service_ticket_contact`) → the contacts EXISTS
predicate is covered; RLS contractor-read-only; deliberate no-audit deviation documented.

**Findings:**
1. **[P2] `cursor.ts` lexicographic timestamp compare → DECIDED (Dan): harden + SQL.** The EF does the
   `(updated_at,id) > cursor` comparison **in SQL** (index-backed via `idx_*_keyset`, time-correct);
   `compareCursor()` is hardened to numeric `Date.getTime()` compare (id tiebreak) so the shared helper
   cannot mis-order under mixed fractional-second precision + a `Z`/`+00:00` suffix. A mis-ordered cursor
   silently SKIPS a booking update (stale call-centre data) — skip is worse than re-send (idempotent).
2. **[P2] EF-build requirement:** `mapTicketToHubspotTicket` reads `t.phone_number` + `t.booking_ref`,
   which tickets do not have as columns — the EF ticket query MUST `JOIN contacts.mobile_e164` (phone) and
   `booking.ref` (when `booking_id` set), else both silently vanish from the Ticket. Cover with a test.
3. **[P3] info:** `verco_url` was created on Order (VER-236) but `mapBookingToOrder` writes the deeplink to
   `hs_external_order_url` and never `verco_url` → a dangling property. Leave it or drop later; harmless.
4. **Open §9 verifies remain the gating items (not new):** live `idProperty` upsert smoke (needs the real
   `HUBSPOT_ACCESS_TOKEN`), the D&M contractor id + initial allowlist, date-only render. EF is **buildable
   now**; **enabling** it stays gated on the first client live in Verco post-cutover (§9.6).
5. **#1 build risk (confirmed, not new):** advisory-lock release on every path (prefer
   `pg_advisory_xact_lock` / try-finally) + cursor advances ONLY for fully-synced rows incl. associations
   (parent-not-synced → lag one tick). Top test focus.

**Added test requirements (VER-239):** (a) cursor skips nothing under same-timestamp + mixed-precision
rows; (b) ticket query joins phone + booking_ref; (c) advisory lock released on success / 429 / throw
(2nd concurrent run no-ops); (d) a child whose parent isn't synced does NOT advance the child cursor;
(e) bearer guard rejects a non-service-role caller.

**Verdict: ENG CLEARED to build.** Spec + as-built foundation are consistent. One P2 helper-hardening
(decided); the rest are EF-build requirements folded into VER-239/240. Build per §10, keep the EF disabled
(empty allowlist) until the first client cuts over.

## 12. References

- Superseded: `2026-05-28-wmrc-hubspot-integration-design.md`
- Pattern source: hardened Attio design (office-hours + eng-review, PR #117) + DM-Ops
  `attio-sync-contact`/`-ticket` EFs
- Live HubSpot state inspected via HubSpot MCP (portal 442091910), 2026-05-29
- Legacy sync: Make (Airtable → HubSpot), `hs_object_source_detail_1: "Make"`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/autoplan` (CEO phase) | Scope & strategy | 1 | REVIEWED | 9 findings; premise gate → "Confirm EF + harden"; structural allowlist + spike-first adopted |
| Eng Review | `/plan-eng-review` ×2 + `/autoplan` (Eng phase) | Architecture & tests | 3 | CLEARED-TO-BUILD | manual: 2 + build-gate; autoplan: 11 (2 CRIT schema, 3 HIGH) all applied; **2026-05-30 focused pre-build review (§11c): as-built confirmed, 1 P2 cursor-hardening decided, build reqs folded into VER-239/240** |
| Dual voices | `/autoplan` | Independent CEO+Eng subagents | 2 | `[subagent-only]` | Codex unavailable; both subagents inspected live HubSpot + types.ts |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (backend sync, no UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | skipped | n/a (internal sync; no external dev surface — keyword matches are infra) |

- **UNRESOLVED:** 2 taste decisions pending Dan (`[GATE-TD1]` contact deeplink, `[GATE-TD2]` currency).
- **VERDICT (revised by /autoplan):** **NOT cleared as originally written — corrected and re-cleared with conditions.** The manual §11a "ENG CLEARED" was over-stated (4 schema errors + a false pg_net visibility claim, now fixed). Direction confirmed at the premise gate (EF + harden). **Build-gate is now TASK ZERO** (§10.0): prove `idProperty` upsert + association idempotency + date-only render on STANDARD tier before any EF code. **EF wiring + final "cleared" gated on the first real client being live in Verco** (build the pure mappers now). Decisions: per-client allowlist (not blanket contractor-scope); Contacts dedupe by email; Orders/Tickets by `verco_*_id`; ticket mapping uses real `service_ticket` columns + `ticket_status` enum; `sync_log` row = visibility + PII audit; omit native `amount`. Linear VER-235..240 to be updated to match.
