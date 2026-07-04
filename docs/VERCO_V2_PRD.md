# Verco v2 — Product Requirements Document

**Version:** 1.1  
**Date:** 2026-03-26 (last reconciled 2026-07-04 — see Change Log)  
**Author:** Dan Taylor (D&M Waste Management) + Claude (technical co-author)  
**Status:** APPROVED — basis for TECH_SPEC  

---

## Change Log

Reconciles this PRD with what actually shipped (the original 2026-03-26 text described intended, not as-built, designs in the noted sections).

| Date | Ver | Change |
|---|---|---|
| 2026-07-04 | 1.1 | **Survey system reconciled to as-built (§11).** Public access is token-gated via anon-callable `SECURITY DEFINER` RPCs (not a DB trigger). Survey questions are a **fixed shared set** (code constant), not per-tenant configurable (that is deferred). Added and shipped: admin surveys module (`/admin/surveys`), dashboard survey feed, standalone `/survey/*` layout, and a `DISABLE_SURVEY_EMAIL` kill-switch. `booking_survey` is keyed by `client_id` (not `tenant_id`). Shipped as PRs #284 / #285 / #287 / #288. |

---

## 1. Product Overview

### 1.1 What Verco Is

Verco is a white-labelled, multi-tenant SaaS platform for managing residential bulk verge collection bookings on behalf of WA local governments. Councils are tenants. Residents book collection services online. Contractor field staff use Verco to manage run sheets and field operations. D&M Waste Management operates the platform and manages all tenants via a separate application (DM-Ops).

### 1.2 What Verco Is Not

- **Not** a general waste management system
- **Not** a route optimisation tool (OptimoRoute integration is future scope)
- **Not** a billing or invoicing platform (Xero integration lives in DM-Ops)
- **Not** a native mobile app (PWA only in v2)

### 1.3 Strategic Context

Verco v2 is a ground-up rebuild of a Lovable-generated prototype. The rebuild is motivated by:

1. Production-grade multi-tenancy with proper RLS enforcement
2. Server-side pricing and booking validation (prototype is client-side only)
3. Separation of Verco booking domain from DM-Ops operational data
4. Positioning Verco as a standalone SaaS product that can be licensed to other waste contractors beyond D&M

### 1.4 Operator

**D&M Waste Management** — manages Verco tenants and their own collection operations via DM-Ops. D&M staff do not use Verco directly in v2; they use DM-Ops which connects to the Verco database via a live Supabase client.

---

## 2. Users & Roles

### 2.1 Role Definitions

| Role | User | Primary Device | Scope |
|---|---|---|---|
| `contractor-admin` | Contractor senior ops (D&M or third-party) | Desktop | All clients under their contractor |
| `contractor-staff` | Contractor ops team | Desktop | All clients — limited write |
| `field` | Contractor field crew | Mobile PWA | All clients — run sheet + closeout, no PII |
| `client-admin` | Council senior officer (e.g. WMRC customer service lead) | Desktop | Own client + all sub-clients |
| `client-staff` | Council back-office | Desktop | Own client + all sub-clients — limited write |
| `ranger` | Council field staff | Mobile PWA | Own client's areas — no PII |
| `resident` | Homeowner | Mobile web | Own bookings only |
| `strata` | Strata manager | Desktop | Authorised MUD properties only |

> **Note:** `dm-admin`, `dm-staff`, `dm-field` are removed from Verco v2. D&M staff operate via DM-Ops using a live Supabase client pointed at the Verco DB.

### 2.2 Role Capabilities Matrix

| Capability | resident | strata | ranger | client-staff | client-admin | field | contractor-staff | contractor-admin |
|---|---|---|---|---|---|---|---|---|
| Book residential collection | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Book MUD collection | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Create Illegal Dumping booking | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| View own bookings | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| View client bookings (no PII) | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| View resident contact details | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Edit bookings | ✓ (own, pre-cutoff) | ✓ (own, pre-cutoff) | ✗ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Cancel bookings | ✓ (own, pre-cutoff) | ✓ (own, pre-cutoff) | ✗ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Raise NCN | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Raise Nothing Presented | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| View NCN / NP | ✓ (own) | ✓ (own) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Mark booking Complete | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Enter MUD allocation count | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Access run sheet | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Manage collection dates | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Manage eligible properties | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ |
| Manage client users | ✗ | ✗ | ✗ | ✗ | ✓ (own client) | ✗ | ✓ | ✓ |
| Approve refunds | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ |
| View service tickets | ✓ (own) | ✓ (own) | ✗ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Manage service tickets | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ | ✓ |
| View reports / analytics | ✗ | ✗ | ✗ | ✓ (own client) | ✓ (own client) | ✗ | ✓ (all clients) | ✓ (all clients) |
| Manage service / allocation rules | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Submit bug reports | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### 2.3 PII Suppression — Ranger & Field Roles

`ranger` and `field` roles receive **zero resident contact information**. The following fields are never returned to these roles under any circumstance:

- `contacts.full_name`
- `contacts.email`
- `contacts.mobile_e164`

This applies to booking views, run sheets, NCN/NP records, and all API responses. Enforced at RLS level — not frontend only. If a field staff member needs to contact a resident, they escalate to a council `admin` or `staff` user.

### 2.4 Strata User Properties

A strata user can manage multiple MUD-eligible properties (e.g. a strata manager who runs several complexes). A junction table `strata_user_properties` links a strata user to their authorised MUD properties. Strata users can only view and book against properties in their junction table.

---

## 3. Booking Types

### 3.1 Overview

| Type | Created by | Payment | Closed by | PII on record |
|---|---|---|---|---|
| Residential | Resident | Stripe (if over allocation) | Field staff | Full |
| MUD | Strata rep | Included in rates | Field staff | Strata contact |
| Illegal Dumping | Ranger | Internally charged | Field staff | None — geo only |
| Call Back - DM | Admin (DM-Ops) | Internal | Field staff | Full |
| Call Back - Client | Admin | Internal | Field staff | Full |

All types share the `booking` table. `booking_type` enum drives flow differences.

### 3.2 Residential Booking Flow

**Steps:** Address → Services → Date → Details → Confirm → Payment (if applicable)

1. **Address** — Resident enters address, matched against `eligible_properties` for their AJA
2. **Services** — Resident selects service types and quantities. Server-side pricing calculates free vs. paid items
3. **Date** — Available `collection_date` records shown for the matched AJA. Dates at soft capacity (60 units) or `bulk_is_closed` / `anc_is_closed` are hidden
4. **Details** — Contact name, mobile (E.164), location on property, notes
5. **Confirm** — Itemised summary showing included vs. extra services with pricing
6. **Payment** — Stripe Checkout if `total_charge > 0`. Booking status = `Pending Payment`. On payment confirmation → `Submitted`
7. **Free bookings** — Skip payment, status goes directly to `Submitted`

### 3.3 MUD Booking Flow

1. Strata rep selects their complex from authorised MUD properties
2. System reserves 2 allocation units on the first available collection date of the month for the AJA
3. No Stripe payment — included in council rates
4. Status → `Submitted` immediately
5. Field staff enter actual allocation count on collection day via mobile — updates `booking_item.no_services`
6. Actual allocation count is immutable to council `admin` and `staff` roles

### 3.4 Illegal Dumping Booking Flow

1. Ranger creates ID booking with: geolocation (lat/lng via browser API), photo(s), waste description, collection date selection
2. No `eligible_properties` lookup — address resolved from geolocation
3. No Stripe payment — internally charged to council
4. Draws from `id` capacity bucket on `collection_date`
5. Status → `Submitted` immediately
6. Appears on run sheet alongside residential bookings

---

## 4. Pricing & Allocation Model

### 4.1 Hierarchy

```
Category (Bulk / ANC / ID)
  └── capacity_bucket → maps to collection_date capacity column
  └── allocation_rules → FY total limit per AJA + overage price
        └── service_type (General, Green, Mattress, etc.)
              └── service_rules → per-service sub-limit per AJA + overage price
```

### 4.2 Capacity Bucket Mapping

`capacity_bucket` is a configurable column on the `category` table to support future service type additions:

| Current categories | Default bucket |
|---|---|
| General, Green | `bulk` |
| Mattress, E-Waste, Whitegoods | `anc` |
| Illegal Dumping (any stream) | `id` |

### 4.3 Server-Side Pricing Algorithm

For each `booking_item` in a booking request:

1. Look up `service_rules` for `account_job_area_id + service_type_id`
2. Sum `booking_item.no_services` for the same `eligible_property_id + service_type_id + financial_year_id` where `booking.status NOT IN ('Cancelled', 'Pending Payment')`
3. Calculate `remaining_free = max_collections - already_used`
4. `free_units = MIN(requested_qty, remaining_free)`
5. `paid_units = requested_qty - free_units`
6. `line_charge = paid_units × extra_unit_price`

Total charge = sum of all line charges. If `total_charge = 0`, skip Stripe. If `total_charge > 0`, initiate Stripe Checkout.

**All pricing logic runs server-side in an Edge Function. `unit_price_cents` is never accepted from the client.**

### 4.4 FY Allocation Tracking

- Allocation is per `eligible_property_id + service_type_id + financial_year_id`
- Tracked against the property, not the contact — new resident at same address does not reset allocation
- `financial_year.is_current` drives which FY is active for new bookings

### 4.5 Mixed Cart Display

Confirm screen shows itemised breakdown:

```
INCLUDED IN ALLOCATION
  General × 1        Included
  Green × 1          Included

EXTRA SERVICES
  Green × 1 @ $89.67    $89.67

Total                 $89.67
```

---

## 5. Booking Lifecycle & State Machine

### 5.1 Status Enum

`Pending Payment` → `Submitted` → `Confirmed` → `Scheduled` → `Completed`

Branch states: `Cancelled`, `Non-conformance`, `Nothing Presented`, `Rebooked`, `Missed Collection`

### 5.2 Transition Rules

| From | To | Trigger | Who |
|---|---|---|---|
| (new) | Pending Payment | Booking created, Stripe required | System |
| (new) | Submitted | Booking created, no payment required | System |
| Pending Payment | Submitted | Stripe payment confirmed | Stripe webhook |
| Pending Payment | Cancelled | Payment abandoned / expired | System |
| Submitted | Confirmed | Admin confirms | admin / staff |
| Confirmed | Scheduled | 3:30pm D-1 automatic transition | Scheduled function |
| Scheduled | Completed | Field staff marks complete | field |
| Scheduled | Non-conformance | Field staff raises NCN | field |
| Scheduled | Nothing Presented | Field staff raises NP | field |
| Non-conformance | Rescheduled | Admin reschedules | admin |
| Nothing Presented | Rebooked | Admin rebooks | admin |
| Any pre-Scheduled | Cancelled | Resident or admin cancels | resident / admin / staff |

**Invalid transitions are rejected at DB level via trigger.**

### 5.3 Cancellation & Scheduling Lock

- **Cutoff:** 3:30pm AWST the day prior to collection date
- **Mechanism:** Automated function transitions all `Confirmed` bookings for the next day to `Scheduled` at 3:30pm daily
- **Effect of Scheduled status:** Booking is immutable to residents, council admin, and council staff
- **Override:** DM-Ops `dm-admin` / `dm-staff` only — via direct Supabase client, not Verco UI

### 5.4 Refund Flow

1. Resident or admin raises refund request → `refund_request` record created, status `Pending`
2. DM-Ops staff review and approve
3. Approval triggers `process-refund` Edge Function → Stripe refund initiated
4. `refund_request.status` → `Approved`, `stripe_refund_id` stored

---

## 6. Collection Dates & Capacity

### 6.1 Capacity Model

Each `collection_date` has three independent capacity buckets:

| Bucket | Column | Driven by |
|---|---|---|
| Bulk | `bulk_capacity_limit` / `bulk_units_booked` | General + Green services |
| ANC | `anc_capacity_limit` / `anc_units_booked` | Mattress + E-Waste + Whitegoods |
| ID | `id_capacity_limit` / `id_units_booked` | Illegal Dumping bookings |

### 6.2 Soft Cap

- Bookable limit: **60 units** (configurable per tenant)
- Physical capacity: **70 units** (10-unit buffer for IDs and overrides)
- `bulk_is_closed` / `anc_is_closed` flags control resident-visible availability
- Flags are recalculated on every `booking_item` change via DB trigger

### 6.3 Concurrency Control

Capacity check and booking insert are wrapped in a serialisable transaction in the `create-booking` Edge Function. A Postgres advisory lock keyed on `collection_date_id` prevents race conditions under concurrent bookings.

### 6.4 Attended Collections (for CPPH sync)

For DM-Ops CPPH analytics, "attended" = bookings where `status IN ('Completed', 'Non-conformance', 'Nothing Presented')`. The nightly aggregate sync to DM-Ops uses this definition, grouped by `job_id + area_id + collection_date`.

---

## 7. Run Sheets

### 7.1 Definition

A run sheet is a derived, read-only view of `booking` + `booking_item` records for a given `collection_date + account_job_area`. It is not a stored entity.

### 7.2 Run Sheet Contents

Per booking line:

- Booking reference
- Address (from `eligible_properties.formatted_address`)
- Location on property
- Service type + quantity
- Booking type (Residential / MUD / ID)
- Status
- Notes
- NCN / NP indicator (if exists)
- Google Maps deep link (`https://maps.google.com/?q=lat,lng`)

Contact details (name, mobile, email) are **never** included on run sheets. `field` and `ranger` roles receive no resident PII. All PII suppression is enforced at RLS level.

### 7.3 Future Integration

OptimoRoute integration is **out of scope for v2**. The data model includes a nullable `crew_id` column on `booking` for future crew assignment. (The original `optimo_stop_id` placeholder was dropped 02/07/2026 — the shipped OR sync keys stops on `collection_stop.external_order_ref` instead.)

---

## 8. Notifications

### 8.1 Notification Matrix

| Trigger | Channel | Recipient | Template |
|---|---|---|---|
| Booking created | Email | Resident | Booking confirmation — full details |
| Booking created | SMS | Resident | "Your booking is confirmed. View: {short_url}" |
| Extra services paid | Email | Resident | Stripe receipt |
| Booking updated | Email | Resident | Updated booking details |
| Booking cancelled | Email | Resident | Cancellation confirmation |
| Place-out reminder | Email + SMS | Resident | "You can now place your waste on the verge. Must be out by 7am on {date}." |
| NCN raised | Email | Resident | NCN details + photo |
| NP raised | Email | Resident | NP details + photo |
| Collection completed | Email | Resident | Survey link |

### 8.2 Rules

- **One place-out reminder per booking** — fired at `tenant.sms_reminder_days_before` days before collection date
- **Survey:** one per booking, fired on `status → Completed`, hosted in Verco, responses stored in `booking_survey` table
- **Notification log:** every send attempt (success or fail) recorded in `notification_log` with channel, type, status, error

### 8.3 Sender Identity

Per-tenant configuration:
- SMS sender ID (`tenant.sms_sender_id`) — resident sees council name
- Reply-to email address — resident replies to council, not D&M
- Email from name — council name

---

## 9. White-Label & Tenancy

### 9.1 Tenant Identification

Tenants are identified by subdomain at runtime:

- `kwn.verco.au` → Kwinana tenant
- `cot.verco.au` → Cockburn tenant
- Custom domain option: `bookings.kwinana.wa.gov.au` → CNAME to `kwn.verco.au`

Middleware resolves tenant from hostname on every request. No build-time config per tenant.

### 9.2 Branding Tiers

**Tier 1 — Design tokens (always configurable):**

| Field | Description |
|---|---|
| `logo_light_url` | Logo for light backgrounds |
| `logo_dark_url` | Logo for dark backgrounds |
| `primary_colour` | Hex — drives all button/link/accent colours |
| `service_name` | e.g. "Verge Collection Bookings" |
| `hero_banner_url` | Landing page banner image |

**Tier 2 — Content slots (optional, fallback to global defaults):**

| Slot | Default |
|---|---|
| Landing page headline | "Book your verge collection" |
| Landing page subheading | Generic tagline |
| FAQ items | Global D&M defaults (extendable per tenant) |
| Contact details | D&M support contact |
| Privacy policy URL | Global Verco privacy policy |
| Confirmation email footer | Generic D&M footer |

Stored in `tenant_branding` table as `tenant_id + key + value`. New slots added without schema changes.

### 9.3 Client Onboarding Checklist

Minimum configuration required before first resident booking:

1. Contractor record exists (created once per contractor)
2. Client record created (name, slug, is_active)
3. Sub-client records created if applicable (e.g. COT, CAM under WMRC)
4. Client branding configured (logo, colours, service name, show_powered_by)
5. Notification config (SMS sender ID, reply-to email, email from name)
6. Financial year configured (`is_current = true`)
7. SLA configuration per priority level
8. Place-out reminder days set (`sms_reminder_days_before`)
9. Collection areas created with `dm_job_code` reference
10. Allocation rules per collection area + category
11. Service rules per collection area + service type
12. Eligible properties loaded (residential)
13. MUD properties loaded and flagged (`is_mud = true`) if applicable
14. Collection dates created with capacity limits
15. Client admin user created and invited

---

## 10. Analytics & Reporting

### 10.1 Scope

All reporting is **tenant-scoped only**. No cross-tenant benchmarking in-app.

### 10.2 Council Dashboard Reports

| Report | Description |
|---|---|
| Upcoming bookings by collection date | Count + service breakdown per date |
| Weekly completed / NCN / NP tally | 7-day rolling summary |
| FY allocation consumption per service type | Used vs. entitlement per service |
| NCN reason breakdown | Frequency by reason code |
| Collection date fill rate | % capacity used per date |
| Cancellation rate | Inside vs. outside cutoff window |
| Survey response scores | CSAT per collection date trend |
| Properties with repeat extra charges | Heavy users in current FY |

### 10.3 DM-Ops Cross-Tenant Reports (via DM-Ops, not Verco)

| Report | Description |
|---|---|
| Extra services revenue by tenant + FY | Overage revenue per contract |
| NP rate by tenant | Nothing Presented as % of Scheduled |
| NCN rate by tenant | Non-conformance as % of Scheduled |
| Notification delivery failures | Bounce rates by tenant |
| Tenant config completeness | Missing onboarding items |

---

## 11. Surveys

_As-built, reconciled 2026-07-04 (shipped #284/#285/#287/#288). Original 1.0 text described a DB trigger + per-tenant question config; see Change Log._

- One survey per booking, created when the booking reaches `Completed` (at field closeout), enforced `UNIQUE (booking_id)` — one submission per booking
- Survey is tenant-branded (logo + service name from the `client` record) and hosted in Verco on a standalone `/survey/[token]` page (no resident app chrome)
- Survey link in the completion email is a short URL with an unguessable token (no login required); the logged-out page reads + submits through anon-callable `SECURITY DEFINER` RPCs
- Responses stored in `booking_survey`: `booking_id, client_id, token, submitted_at, responses (jsonb)`
- **Survey questions are a fixed shared set** (stable analytics ids, comparable across councils) — per-tenant custom questions are a **future** capability (the `client_survey_config` table exists but is unwired)
- Aggregate scores + response rate (vs completed bookings) available in the admin surveys module and a dashboard feed; a completion email can be paused with `DISABLE_SURVEY_EMAIL`

---

## 12. Service Tickets

The `booking_enquiry` table is renamed conceptually to **service tickets** in v2 (code and UI align to this naming). Full ticket semantics:

- Categories: `general`, `booking`, `billing`, `service`, `complaint`, `other`
- Channels: `portal`, `phone`, `email`, `form`
- Priority: `low`, `normal`, `high`, `urgent`
- Status: `open`, `in_progress`, `waiting_on_customer`, `resolved`, `closed`
- SLA tracking per tenant + priority (from `sla_config`)
- Internal notes (staff only, not visible to resident)
- Attio CRM sync (contact + ticket upsert)

---

## 13. Infrastructure & Architecture Boundaries

### 13.1 Entity Hierarchy

```
Contractor          (D&M, future third-party contractors)
  └── Client        (WMRC, KWN — council or umbrella body)
        └── Sub-client   (CAM, COT, MOS, FRE... — optional, WMRC only)
              └── Collection Area   (VV-COT, VV-CAM-A, KWN-1 — atomic booking unit)
```

- **KWN path:** `D&M → KWN → [no sub-client] → KWN-1, KWN-2, KWN-3, KWN-4`
- **WMRC path:** `D&M → WMRC → COT → VV-COT`

### 13.2 Verco Supabase Project

- **Separate** from DM-Ops Supabase project
- **Region:** ap-southeast-2 (Sydney) — Australian data residency
- Contains only booking-domain tables
- No DM-Ops operational tables

### 13.3 Hosting

- **Platform:** Coolify (self-hosted) on BinaryLane
- **Tenant resolution:** Next.js middleware running in Node container — no edge runtime required
- **Deployment model:** Shared multi-tenant — `contractor_id` is the top-level isolation key
- **Multi-contractor isolation:** RLS enforced at DB level — no contractor can see another's data

### 13.4 Portal URL Model

| Client | URL | Resolved by |
|---|---|---|
| KWN | `kwn.verco.au` or `bookings.kwinana.wa.gov.au` | `client.slug` or `client.custom_domain` |
| WMRC (Verge Valet) | `vergevalet.verco.au` or `book.vergevalet.com.au` | `client.slug` or `client.custom_domain` |
| Future contractor | `contractor.verco.au` | `client.slug` |

Residents never select their sub-client or collection area manually — the address lookup silently resolves it via `eligible_properties.collection_area_id`.

### 13.5 DM-Ops Integration

| Integration | Mechanism |
|---|---|
| Contractor/client/booking management | DM-Ops holds a live Supabase client pointed at Verco DB |
| CPPH analytics | Nightly aggregate sync: `dm_job_code + date + attended_count` → DM-Ops via `nightly-sync-to-dm-ops` Edge Function |
| Refund approval | DM-Ops triggers `process-refund` Edge Function via Verco API |

### 13.6 Payment

- **Provider:** Stripe (single D&M account)
- `client_id` and `contractor_id` stored on all payment records for future Stripe Connect migration
- Server-side price calculation only — client never sets `unit_price_cents`
- MUD and ID bookings bypass Stripe entirely

### 13.7 External Integrations

| Service | Purpose | Scope |
|---|---|---|
| Stripe | Resident payment processing | v2 |
| Attio CRM | Contact + ticket sync | v2 |
| Google Places | Address autocomplete proxy | v2 |
| SMS provider | Booking + reminder SMS | v2 |
| OptimoRoute | Route optimisation + crew assignment | Future |

---

## 14. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Availability | 99.5% uptime (Supabase SLA) |
| Mobile performance | Lighthouse score ≥ 85 on 4G mobile |
| Accessibility | WCAG 2.1 AA — public booking flow |
| Data residency | All data stored in Australia (ap-southeast-2) |
| Auth | Email OTP only (no passwords) |
| Session | JWT, auto-refresh, localStorage |
| Concurrency | Serialisable transactions for capacity-critical writes |
| Audit | All booking, NCN, NP, service ticket mutations logged to `audit_log` |
| Test coverage | ≥ 80% unit coverage on pricing and state machine logic |

---

## 15. Out of Scope — v2

The following are explicitly excluded from v2:

- OptimoRoute integration
- Stripe Connect (multi-operator payments)
- Native mobile app (iOS/Android)
- Cross-tenant benchmarking / analytics
- Email template management UI
- Offline mode
- Push notifications (beyond SMS)
- Council-to-D&M invoicing within Verco
- Xero integration within Verco

---

## 16. Success Metrics

| Metric | Target |
|---|---|
| Booking completion rate | ≥ 85% of started bookings completed |
| Cancellation rate | ≤ 8% of confirmed bookings |
| NCN rate | ≤ 5% of scheduled collections |
| NP rate | ≤ 3% of scheduled collections |
| Survey response rate | ≥ 30% of completed bookings |
| Time to onboard new tenant | ≤ 4 hours from zero to first live booking |
| Overbooking incidents | 0 in normal operation |

---

*End of PRD v1.0. Next artefact: TECH_SPEC (data model, API contracts, auth architecture, RLS design).*
