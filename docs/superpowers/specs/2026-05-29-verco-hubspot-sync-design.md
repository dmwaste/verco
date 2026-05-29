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
         ▼  HubSpot REST upsert (idProperty = verco_*_id)  [no id writeback → no loop]
       Contact (0-1)      Order (0-123)        Ticket (0-5)
         │                                        │ booking_ref ← Verco booking ref
         └── associations: Order→Contact, Ticket→Contact (+Ticket→Order)

Legacy Make sync (Airtable → HubSpot) keeps running for areas NOT yet in Verco.
As each area migrates to Verco, it stops in Airtable and starts via this EF.
```

**Coexistence with Make (no double-feed):** Airtable and Verco use **completely different
naming** (confirmed), so refs never collide. An area lives in *one* source at a time — when
Kwinana migrates, its Airtable feed stops and the EF takes over. Historical Airtable-sourced
Orders remain as legacy records (different ids/refs); new Verco Orders come in fresh. No
dedupe bridge needed *between* the two sources.

## 4. Entity mapping (Verco → HubSpot) — schema-verified

| Verco (Supabase) | → HubSpot | Mapping | Deeplink (`verco.au`) |
|---|---|---|---|
| `contacts` | Contact `0-1` | firstname, lastname, email, phone ← `mobile_e164`; **`verco_contact_id`** (=`contacts.id`, upsert key), `verco_url` | `/admin/contacts/{id}` |
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

## 12. References

- Superseded: `2026-05-28-wmrc-hubspot-integration-design.md`
- Pattern source: hardened Attio design (office-hours + eng-review, PR #117) + DM-Ops
  `attio-sync-contact`/`-ticket` EFs
- Live HubSpot state inspected via HubSpot MCP (portal 442091910), 2026-05-29
- Legacy sync: Make (Airtable → HubSpot), `hs_object_source_detail_1: "Make"`
