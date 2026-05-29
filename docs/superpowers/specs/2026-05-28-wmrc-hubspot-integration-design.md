# WMRC HubSpot Integration — Design

**Status:** Draft for WMRC meeting (2026-05-28)
**Author:** Dan Taylor (with Claude)
**Linear:** TBD (open after WMRC meeting)

---

## 1. Summary

One-way replication of three Verco entities (`contacts`, `booking`, `service_ticket`) into WMRC's HubSpot tenant. Verco emits HMAC-signed webhooks on insert/update; WMRC owns the HubSpot-side ingestion, schema, and automation.

**Positioning:** HubSpot is the **phone-call context layer** for WMRC CSOs ("who is this resident, what's their booking history, do they have an open ticket?"). All ticket *work* — assignment, response, resolution — stays in Verco. The CSO clicks the `verco_url` deep-link on a HubSpot record to act.

This intentionally avoids two-system state drift: ticket lifecycle has exactly one source of truth (Verco).

## 2. Goals

- WMRC CSOs see Verco contacts, bookings, and service tickets inside HubSpot, in near-real-time
- Every HubSpot record carries a deep-link back to the corresponding Verco admin page
- Verco owns the data contract; WMRC owns the HubSpot side (workflows, automations, ticket pipelines)
- Multi-tenant by design — same plumbing can serve Rockingham, Kwinana, etc. later
- Forward-compatible with future two-way actions (Phase 3) without re-architecture

## 3. Non-Goals (Phase 1)

- Mirroring `ticket_response` records (replies stay in Verco; CSOs read them by clicking through)
- Two-way actions from HubSpot back into Verco (Phase 3)
- HubSpot-originated tickets flowing into Verco
- Real-time push of D&M staff identifiers (`assigned_to`, `assigned_to_name`) — stripped from payload
- Booking *line items* (services breakdown beyond a summary string)
- Admin UI for managing webhook subscriptions — Phase 1 is manual `INSERT` per client
- Other WMRC use cases (marketing lifecycle, BI dashboards, full CRM journey)

## 4. Architecture

```
Verco DB
  ├── contacts          (INSERT/UPDATE)
  ├── booking           (INSERT/UPDATE, status changes)
  └── service_ticket    (INSERT/UPDATE)
            │
            ▼  AFTER trigger → INSERT into webhook_delivery (queued)
  webhook_subscription  (per client × per entity)
            │
            ▼  pg_cron every 30s (or NOTIFY-driven)
  emit-webhook  Edge Function
            │  POST + X-Verco-Signature (HMAC-SHA256)
            ▼
  WMRC HubSpot ingestion endpoint
  (Operations Hub custom-code workflow action, or Serverless Function)
            │
            ▼
  HubSpot upserts by verco_id
    ├── Standard Contact     (verco_id custom property)
    ├── Custom Object: verco_booking
    └── Standard Ticket      (verco_id custom property)
```

### 4.1 Why webhook + queue table rather than direct EF invocation from trigger

- DB trigger can't make external HTTP calls cleanly without `pg_net`, and we want retries/backoff/dead-letter logging
- Queue table makes replay, audit, and outage recovery trivial
- Decouples write-path latency from HubSpot availability — Verco writes don't slow down when HubSpot is sluggish
- Same pattern used successfully elsewhere in Verco (notification dispatch — `notification_log`)

## 5. Schema Changes

### 5.1 New tables

```sql
CREATE TABLE webhook_subscription (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  entity       text NOT NULL CHECK (entity IN ('contact','booking','service_ticket')),
  target_url   text NOT NULL CHECK (target_url ~* '^https://'),
  secret       text NOT NULL,                  -- 32+ char random, generated server-side
  is_active    boolean NOT NULL DEFAULT true,
  description  text,                           -- e.g. "WMRC HubSpot — Service Tickets"
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, entity, target_url)
);

CREATE TABLE webhook_delivery (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES webhook_subscription(id) ON DELETE CASCADE,
  entity          text NOT NULL,
  action          text NOT NULL CHECK (action IN ('created','updated','deleted')),
  verco_id        uuid NOT NULL,
  payload         jsonb NOT NULL,              -- full body that will be POSTed
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','delivered','failed','dead_letter')),
  attempt_count   int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  next_retry_at   timestamptz NOT NULL DEFAULT now(),
  http_status     int,
  response_body   text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_delivery_pending
  ON webhook_delivery (next_retry_at)
  WHERE status = 'pending';
```

### 5.2 New columns on existing tables

```sql
ALTER TABLE contacts        ADD COLUMN hubspot_record_id text;
ALTER TABLE booking         ADD COLUMN hubspot_record_id text;
ALTER TABLE service_ticket  ADD COLUMN hubspot_record_id text;
```

Populated by ack endpoint in Phase 2. Phase 1 leaves them NULL — no harm.

### 5.3 RLS

- `webhook_subscription`: SELECT/INSERT/UPDATE/DELETE for `contractor-admin` only. Other roles: deny.
- `webhook_delivery`: SELECT for `contractor-admin` only (audit/replay UI). No client/resident access.

## 6. Trigger + Queue Mechanics

Single trigger function `enqueue_webhook_delivery()` attached to `contacts`, `booking`, `service_ticket`:

1. Determines the `client_id` for the row (direct on booking/service_ticket; via `eligible_property` join for contact if needed — confirm during implementation)
2. Looks up active `webhook_subscription` rows for `(client_id, entity)`
3. For each subscription, builds the payload from row data (see §7) and INSERTs into `webhook_delivery` with `status='pending'`
4. Does NOT block the original write — wrapped in `SECURITY DEFINER` and exception-tolerant

A pg_cron job runs every 30 seconds, invoking `emit-webhook` EF which:
1. Selects up to N pending deliveries with `next_retry_at <= now()`
2. POSTs each to target_url with HMAC signature
3. Updates row to `delivered` (on 2xx) or increments `attempt_count` + sets `next_retry_at` (on failure)
4. Marks `dead_letter` after 6 failed attempts (~24h total)
5. Returns HTTP 500 to pg_cron if an unexpected error occurs (e.g. signature computation crash). HubSpot HTTP failures are expected and re-queued via `next_retry_at` — they do NOT cause a 500.

Trigger fires on INSERT and UPDATE only. DELETE is not wired — Verco entities don't hard-delete (cancellation/closure are status fields). The `"deleted"` action value is reserved in the enum for forward compatibility but never emitted in Phase 1.

## 7. Payload Contract

> **Note:** payload keys are an **external contract with WMRC**, deliberately decoupled from
> Verco column names. Each per-entity section below lists the Verco source for every field
> (verified against `src/lib/supabase/types.ts`, 2026-05-29). Do not assume a key maps 1:1 to
> a `booking`/`contacts` column — several are derived via joins.

### 7.1 Envelope

```json
{
  "webhook_id": "uuid",
  "entity": "contact" | "booking" | "service_ticket",
  "action": "created" | "updated" | "deleted",
  "occurred_at": "2026-05-28T03:00:00Z",
  "schema_version": 1,
  "verco_id": "uuid",
  "verco_url": "https://verco.au/admin/{path}/{id}",
  "client": { "id": "uuid", "slug": "verge-valet" },
  "data": { ... per-entity fields below ... }
}
```

`verco_url` paths:
- `contact` → `https://verco.au/admin/contacts/{id}`
- `booking` → `https://verco.au/admin/bookings/{id}`
- `service_ticket` → `https://verco.au/admin/tickets/{id}`

Production host hard-coded for now. If WMRC ever has a UAT HubSpot tenant pointed at `vvtest.verco.au`, we add a `base_url` column to `webhook_subscription` later.

### 7.2 `contact.data`

```json
{
  "id": "uuid",
  "first_name": "Jane",
  "last_name": "Smith",
  "email": "jane@example.com",
  "mobile_e164": "+61400000000",
  "created_at": "...",
  "updated_at": "..."
}
```

`full_name` deliberately excluded — it's a generated column in Verco; HubSpot concatenates its own from first+last.

### 7.3 `booking.data`

```json
{
  "id": "uuid",
  "reference": "VV-12345",
  "status": "Confirmed",
  "collection_date": "2026-05-30",
  "address": "23 Leda Blvd, Wellard WA 6170",
  "latitude": -32.27,
  "longitude": 115.79,
  "contact_verco_id": "uuid",
  "contact_email": "jane@example.com",
  "services_summary": "1× General Bulk, 2× Mattress",
  "total_cents": 0,
  "created_at": "...",
  "updated_at": "..."
}
```

**Verco source mapping** (`booking` has no date/price/address columns of its own — these are derived):

| Payload key | Verco source |
|---|---|
| `id` | `booking.id` |
| `reference` | `booking.ref` (column is `ref`, **not** `reference`) |
| `status` | `booking.status` |
| `collection_date` | `MIN(collection_date.date)` via `booking_item.collection_date_id` → `collection_date.date` |
| `address` | `eligible_properties.formatted_address` ?? `eligible_properties.address` via `booking.property_id`; fallback `booking.geo_address` / `booking.location` |
| `latitude` / `longitude` | `booking.latitude` / `booking.longitude` (real columns) |
| `contact_verco_id` | `booking.contact_id` (nullable — skip unassociated bookings) |
| `contact_email` | `contacts.email` via `contact_id` join |
| `services_summary` | aggregated from `booking_item` (`service.name` × `no_services`) |
| `total_cents` | `SUM(booking_item.unit_price_cents × booking_item.no_services)` — there is **no** `booking.total_cents` (price lives on `booking_item`) |
| `created_at` / `updated_at` | `booking.*` |

**Address is a single string** — Verco does not decompose `suburb`/`postcode` (they exist on
neither `booking` nor `eligible_properties`). WMRC parses it their side if they need the parts
(see §12).

`contact_verco_id` + `contact_email` let HubSpot's workflow associate the custom-object booking to the right Contact without a secondary lookup.

### 7.4 `service_ticket.data`

```json
{
  "id": "uuid",
  "display_id": "TKT-001234",
  "subject": "Bin not collected",
  "message": "...",
  "status": "open",
  "priority": "normal",
  "category": "missed_collection",
  "channel": "phone",
  "contact_verco_id": "uuid",
  "contact_email": "jane@example.com",
  "booking_verco_id": "uuid",
  "first_response_at": null,
  "resolved_at": null,
  "closed_at": null,
  "created_at": "...",
  "updated_at": "..."
}
```

**`assigned_to` / `assigned_to_name` deliberately omitted.** D&M staff identity is not shared with WMRC — minimises PII and avoids the "who's Robert?" confusion in HubSpot.

### 7.5 Signature header

```
X-Verco-Signature: t=1716860400,v1=<hex(hmac_sha256(secret, "t=...\n" + raw_body))>
```

Stripe-style. WMRC's ingestion verifies by recomputing HMAC over `"t=<t>\n<raw_body>"`. Window: reject if `|now - t| > 300s` to prevent replay.

## 8. Backfill

One-shot `backfill-webhooks` EF, invoked manually with `(client_id, entity)`:
1. SELECT all rows from the entity table for that client
2. INSERT into `webhook_delivery` with `action='created'`, status `pending`
3. Batches of 50 with a 1s pause between batches to stay polite to HubSpot's rate limits
4. Logs progress to a temp `backfill_run` table

Used once per (client, entity) at go-live. Idempotent if WMRC re-runs because HubSpot upserts by `verco_id`.

## 9. Phase 2 — Ack endpoint (NOT built in Phase 1)

Future EF `webhook-ack` — WMRC's HubSpot workflow POSTs back after creating the HubSpot record:

```
POST /functions/v1/webhook-ack
{ "verco_id": "uuid", "entity": "service_ticket", "hubspot_record_id": "9871234" }
```

Writes `hubspot_record_id` onto the source row. Enables:
- Reverse deep-linking (`verco_admin → HubSpot record`)
- Phase 3 two-way actions (look up "which HubSpot ticket corresponds to this Verco ticket")

## 10. Phase 3 — Two-way actions (NOT built in Phase 1)

Documented intent only. Future endpoints under `/api/integrations/hubspot/*`:

- `POST /api/integrations/hubspot/bookings/:id/cancel`
- `POST /api/integrations/hubspot/tickets/:id/close`
- `POST /api/integrations/hubspot/tickets/:id/respond`

Authenticated via HubSpot-issued bearer token (subscription holds a reverse `inbound_secret`). RLS context = synthetic `hubspot-system` role mapped to the subscription's `client_id` — but **not** built until WMRC asks.

## 11. Security

| Concern | Mitigation |
|---|---|
| Payload tampering | HMAC-SHA256 in `X-Verco-Signature`; WMRC verifies |
| Replay | Timestamp in signature, ±300s window |
| Secret leak | Per-subscription secret; rotatable (UPDATE row, share new) |
| Wrong target URL | DB CHECK constraint `~* '^https://'`; manual review at subscribe time |
| PII in transit | TLS-only; `assigned_to` stripped; no payment data |
| WMRC endpoint compromised | Webhook contains data WMRC already controls (council residents) — equivalent to existing data sharing |
| Dead-letter accumulation | Admin dashboard surfaces dead-lettered deliveries; manual replay endpoint |

## 12. Open Questions for the WMRC Meeting

1. **HubSpot tier?** Custom objects require Operations Hub Pro or Enterprise. If not licensed, bookings degrade to a Contact properties block or timeline events. Confirm before agreeing on the custom-object approach.
2. **Ingestion target?** Operations Hub custom-code workflow action (cleanest) vs HubSpot Serverless Function vs an external Make/Zapier scenario. WMRC's call — we just need one HTTPS URL per entity.
3. **Property names** for the `verco_booking` custom object — align on snake_case (matches our payload) vs camelCase (HubSpot default convention).
4. **Backfill window** — propose 1-week shadow period where data flows but WMRC automations are paused, so they validate before turning on lifecycle/ticket workflows.
5. **CSO Verco accounts** — confirm WMRC CSOs already have `client-admin` (VV-COT, VV-MOS) logins, since `verco_url` deep-links require it. Believed yes; confirm.
6. **`contacts` filtering** — `contacts` is a shared table across all Verco clients. We only send a contact to WMRC HubSpot if that contact has at least one booking under WMRC's `client_id`. Confirm trigger logic handles this scoping correctly.
7. **Phase 2/3 appetite** — get WMRC's read on whether they want two-way eventually, so we size and price accordingly.
8. **Address granularity** — the booking payload sends `address` as a **single string** (Verco
   stores it as one field; suburb/postcode are not separately available). Confirm WMRC's
   HubSpot mapping accepts one address string, or that they're happy to parse it their side.

## 13. Rollout Plan

| Step | Owner | Notes |
|---|---|---|
| 1. Agree spec (this doc) at WMRC meeting | Dan | Locks contract |
| 2. WMRC creates HubSpot custom object schema | WMRC | Property names per §7 |
| 3. Build `webhook_subscription` + `webhook_delivery` tables + RLS | Verco (us) | Migration |
| 4. Build `enqueue_webhook_delivery` trigger | Verco | Trigger on all 3 tables |
| 5. Build `emit-webhook` EF + pg_cron | Verco | HMAC, retries, dead-letter |
| 6. WMRC builds ingestion endpoint | WMRC | They share URL + take our shared secret |
| 7. INSERT WMRC subscriptions (3 rows) | Verco | Manual SQL via Studio |
| 8. Smoke: create one test ticket; observe end-to-end | Both | |
| 9. Run `backfill-webhooks` per entity | Verco | Shadow period begins |
| 10. WMRC turns on workflows | WMRC | After ≥1 week shadow |
| 11. Monitor `webhook_delivery` for dead-letters weekly for first month | Verco | |

## 14. Success Criteria

- WMRC CSO opens a HubSpot Contact for a known resident and sees: 1+ Booking custom objects, 0–N Service Ticket records, all with working `verco_url` deep-links
- A new ticket created in Verco appears in HubSpot within 60 seconds
- `webhook_delivery` failure rate (failed/total) below 1% rolling 7-day
- No data flow blockage when HubSpot has a brief outage — deliveries queue and drain
- Zero D&M staff names visible in WMRC's HubSpot

## 15. References

- Verco service_ticket table — [supabase/migrations/20260326053510_initial_schema.sql](../../supabase/migrations/20260326053510_initial_schema.sql) (search "CREATE TABLE service_ticket")
- Notification dispatch pattern (mirror of this design's queue+EF approach) — [supabase/functions/_shared/notifications/dispatch.ts](../../supabase/functions/_shared/notifications/dispatch.ts)
- HMAC-signed webhook convention (Stripe-style) — Stripe docs, signature scheme `v1`
- CLAUDE.md §11 — Edge Function conventions
- CLAUDE.md §12 — RLS rules for new tables
