# Verco v2 — Technical Specification

**Version:** 1.1  
**Date:** 2026-03-26 (last reconciled 2026-07-04 — see Change Log)  
**Status:** APPROVED — implementation basis for Claude Code  
**Companion docs:** `VERCO_V2_PRD.md`, `CLAUDE.md`

---

## Change Log

Reconciles this spec with what actually shipped (the original 2026-03-26 text described intended, not as-built, designs in the noted sections).

| Date | Ver | Change |
|---|---|---|
| 2026-07-04 | 1.1 | **Survey system reconciled to as-built (§13).** The `booking.status → Completed` DB trigger was **dropped** — survey rows are created by the field closeout action (`maybeCreateCompletionSurvey`), and public token access goes through anon-callable `SECURITY DEFINER` RPCs `get_survey_by_token(text)` / `submit_survey_by_token(text, jsonb)` (migration `20260704000000`), replacing the `/api/survey` route + direct `booking_survey` access (which RLS blocked for anon). Survey questions are a **fixed code constant** (`src/lib/survey/questions.ts`), not loaded from `client_survey_config` (defined but unwired — deferred). `tenant_*` names throughout are the legacy names; the shipped schema uses `client_*` (see §7 rename table). Shipped as PRs #284 / #285 / #287 / #288. |

---

## 1. Stack Decisions

| Layer | Technology | Rationale |
|---|---|---|
| Framework | Next.js 15 (App Router) | Server components for server-side pricing, middleware for tenant + auth routing, ISR for public pages |
| Language | TypeScript 5 (strict mode) | Strict null checks on — prototype had this off |
| Styling | Tailwind CSS 4 | |
| UI Components | shadcn/ui (Radix primitives) | Carry forward from prototype |
| Forms | react-hook-form + zod | Carry forward |
| Server state | TanStack Query v5 | Carry forward |
| Backend | Supabase (separate AU project) | ap-southeast-2, new project — not the prototype project |
| Auth | Supabase Auth (email OTP) | Carry forward — no passwords |
| Payments | Stripe | Single D&M account |
| SMS | Existing provider (config in `tenant.sms_sender_id`) | |
| Email | Existing `send-email` Edge Function | |
| CRM | Attio | Contact + ticket sync |
| Testing | Vitest + Testing Library + Playwright | Unit + E2E |
| Deployment | Coolify on BinaryLane | Self-hosted, AU data residency, standard Node container |
| Tenant resolution | Next.js middleware (Node) | No edge runtime required — runs in container |
| Package manager | pnpm | Replace mixed npm/bun |

---

## 2. Repository Structure

```
verco-v2/
├── app/
│   ├── (public)/                    # Tenant-resolved public routes
│   │   ├── page.tsx                 # Landing page
│   │   ├── auth/page.tsx            # OTP login
│   │   ├── book/
│   │   │   ├── page.tsx             # Address step
│   │   │   ├── services/page.tsx
│   │   │   ├── date/page.tsx
│   │   │   ├── details/page.tsx
│   │   │   └── confirm/page.tsx
│   │   ├── booking/[ref]/page.tsx   # Booking detail
│   │   ├── dashboard/page.tsx       # Resident dashboard
│   │   └── survey/[token]/page.tsx  # Survey (no auth required)
│   ├── (admin)/                     # Admin routes — role-gated
│   │   └── admin/
│   │       ├── layout.tsx
│   │       ├── page.tsx             # Dashboard
│   │       ├── bookings/
│   │       ├── properties/
│   │       ├── collection-dates/
│   │       ├── non-conformance/
│   │       ├── nothing-presented/
│   │       ├── service-tickets/
│   │       ├── refunds/
│   │       ├── reports/
│   │       └── users/
│   ├── (field)/                     # Field PWA routes — field + ranger
│   │   └── field/
│   │       ├── layout.tsx
│   │       ├── run-sheet/page.tsx
│   │       ├── booking/[ref]/page.tsx
│   │       └── illegal-dumping/new/page.tsx
│   └── api/
│       └── tenant/route.ts          # Tenant resolution endpoint
├── components/
│   ├── ui/                          # shadcn (do not edit)
│   ├── booking/
│   ├── admin/
│   ├── field/
│   └── shared/
├── lib/
│   ├── supabase/
│   │   ├── client.ts                # Browser client
│   │   ├── server.ts                # Server client (cookies)
│   │   └── types.ts                 # Generated types
│   ├── pricing/
│   │   └── calculate.ts             # Server-side pricing engine
│   ├── tenant/
│   │   └── resolve.ts               # Tenant resolution from hostname
│   └── utils/
├── middleware.ts                    # Tenant resolution + auth guards
├── supabase/
│   ├── migrations/                  # Sequential SQL migrations
│   └── functions/                   # Edge Functions
└── tests/
    ├── unit/
    │   ├── pricing.test.ts
    │   └── state-machine.test.ts
    └── e2e/
```

---

## 3. Database Schema

### 3.1 Schema Principles

- All tables use `uuid` primary keys with `gen_random_uuid()` default
- All tables have `created_at timestamptz NOT NULL DEFAULT now()`
- All mutable tables have `updated_at timestamptz NOT NULL DEFAULT now()` + `handle_updated_at` trigger
- Soft deletes via `deleted_at timestamptz` on booking-domain tables
- No DM-Ops tables (docket, timesheet, employee, crew, asset, tender, PO, invoice) — those live in the DM-Ops project
- `tenant_id` present on every table where tenant scoping is required

### 3.2 Enums

```sql
-- Roles (dm-* roles removed — D&M super-admin lives in DM-Ops only)
CREATE TYPE app_role AS ENUM (
  'contractor-admin',
  'contractor-staff',
  'field',
  'client-admin',
  'client-staff',
  'ranger',
  'resident',
  'strata'
);

CREATE TYPE booking_status AS ENUM (
  'Pending Payment',
  'Submitted',
  'Confirmed',
  'Scheduled',
  'Completed',
  'Cancelled',
  'Non-conformance',
  'Nothing Presented',
  'Rebooked',
  'Missed Collection'
);

CREATE TYPE booking_type AS ENUM (
  'Residential',
  'MUD',
  'Illegal Dumping',
  'Call Back - DM',
  'Call Back - Client'
);

-- capacity_bucket enum removed — replaced by `category` table with code column
-- See category table definition below

CREATE TYPE ncn_reason AS ENUM (
  'Collection Limit Exceeded',
  'Items Obstructed or Not On Verge',
  'Building Waste',
  'Car Parts',
  'Asbestos / Fibre Fence',
  'Food or Domestic Waste',
  'Glass',
  'Medical Waste',
  'Tyres',
  'Greens in Container',
  'Hazardous Waste',
  'Items Oversize',
  'Other'
);

CREATE TYPE ncn_status AS ENUM ('Open', 'Under Review', 'Resolved', 'Rescheduled');
CREATE TYPE np_status  AS ENUM ('Open', 'Under Review', 'Resolved', 'Rebooked');

CREATE TYPE ticket_category AS ENUM ('general','booking','billing','service','complaint','other');
CREATE TYPE ticket_channel  AS ENUM ('portal','phone','email','form');
CREATE TYPE ticket_priority AS ENUM ('low','normal','high','urgent');
CREATE TYPE ticket_status   AS ENUM ('open','in_progress','waiting_on_customer','resolved','closed');

CREATE TYPE app_permission_action AS ENUM ('view','create','edit','delete','manage');

CREATE TYPE po_status AS ENUM ('For Review','Rejected','Approved','Approved and Entered');
```

### 3.3 Core Tables

#### `contractor`
```sql
CREATE TABLE contractor (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

#### `client`
```sql
-- Council or umbrella body (WMRC, KWN). Owns the resident portal brand + subdomain.
CREATE TABLE client (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id             uuid NOT NULL REFERENCES contractor(id),
  name                      text NOT NULL,
  slug                      text NOT NULL UNIQUE,   -- subdomain e.g. 'kwn', 'vergevalet'
  custom_domain             text,                   -- e.g. 'book.vergevalet.com.au'
  is_active                 boolean NOT NULL DEFAULT true,
  -- Branding
  logo_light_url            text,
  logo_dark_url             text,
  primary_colour            text,
  service_name              text,
  hero_banner_url           text,
  show_powered_by           boolean NOT NULL DEFAULT true,
  -- Content slots (nullable — fallback to platform defaults)
  landing_headline          text,
  landing_subheading        text,
  contact_name              text,
  contact_phone             text,
  contact_email             text,
  privacy_policy_url        text,
  email_footer_html         text,
  faq_items                 jsonb,
  -- Notification config
  sms_sender_id             text,
  reply_to_email            text,
  email_from_name           text,
  sms_reminder_days_before  integer,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
```

#### `sub_client`
```sql
-- Optional grouping layer. Only exists for clients like WMRC that manage multiple councils.
-- KWN has no sub_client records.
CREATE TABLE sub_client (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES client(id),
  name        text NOT NULL,
  code        text NOT NULL,   -- e.g. 'COT', 'CAM', 'FRE'
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, code)
);
```

#### `collection_area`
```sql
-- Atomic booking unit. Replaces account_job_area entirely.
-- All eligible properties, collection dates, allocation rules, and service rules
-- reference collection_area_id.
CREATE TABLE collection_area (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES client(id),
  sub_client_id   uuid REFERENCES sub_client(id),  -- nullable (KWN has none)
  contractor_id   uuid NOT NULL REFERENCES contractor(id),
  name            text NOT NULL,      -- e.g. 'Fremantle South', 'Kwinana Area 1'
  code            text NOT NULL,      -- e.g. 'VV-FRE-S', 'KWN-V-1'
  dm_job_code     text,               -- DM-Ops / Xero reference only (non-structural)
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, code)
);
CREATE INDEX idx_collection_area_client ON collection_area(client_id);
CREATE INDEX idx_collection_area_contractor ON collection_area(contractor_id);
```

#### `profiles`
```sql
CREATE TABLE profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         text NOT NULL,
  display_name  text,
  contact_id    uuid REFERENCES contacts(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

#### `user_roles`
```sql
CREATE TABLE user_roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role            app_role NOT NULL,
  -- Scope: set contractor_id for contractor-* and field roles
  --        set client_id for client-* and ranger roles
  --        set neither for resident and strata (resolved from property)
  contractor_id   uuid REFERENCES contractor(id),
  client_id       uuid REFERENCES client(id),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id),  -- one role per user
  -- Constraint: contractor roles must have contractor_id
  CONSTRAINT chk_contractor_role CHECK (
    (role IN ('contractor-admin','contractor-staff','field') AND contractor_id IS NOT NULL)
    OR role NOT IN ('contractor-admin','contractor-staff','field')
  ),
  -- Constraint: client roles must have client_id
  CONSTRAINT chk_client_role CHECK (
    (role IN ('client-admin','client-staff','ranger') AND client_id IS NOT NULL)
    OR role NOT IN ('client-admin','client-staff','ranger')
  )
);
```

#### `contacts`
```sql
CREATE TABLE contacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name           text NOT NULL,
  mobile_e164         text NOT NULL,
  email               text NOT NULL,
  last_synced_by      text DEFAULT 'supabase',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

#### `account`
```sql
CREATE TABLE account (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_name     text,
  account_status   text DEFAULT 'New Supplier',
  abn              text,
  email            text,
  phone            text,
  postal_address   text,
  postal_city      text,
  postal_region    text,
  postal_postcode  text,
  xero_contact_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
```

#### `area`
```sql
CREATE TABLE area (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_name   text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

#### `job`
```sql
CREATE TABLE job (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name    text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  is_booked   boolean DEFAULT false,
  is_active   boolean DEFAULT true,
  account_id  uuid REFERENCES account(id),
  tenant_id   uuid REFERENCES tenant(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

#### `account_job_area` (central junction entity)
```sql
CREATE TABLE account_job_area (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  account_id  uuid NOT NULL REFERENCES account(id),
  job_id      uuid NOT NULL REFERENCES job(id),
  area_id     uuid NOT NULL REFERENCES area(id),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, job_id, area_id)
);
```

#### `category`
```sql
-- Capacity grouping: Bulk, Ancillary, Illegal Dumping
-- Replaces the old capacity_bucket enum
CREATE TABLE category (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,   -- 'Bulk', 'Ancillary', 'Illegal Dumping'
  code         text NOT NULL UNIQUE,   -- 'bulk', 'anc', 'id'
  description  text,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed data
INSERT INTO category (name, code, description, sort_order) VALUES
  ('Bulk',            'bulk', 'General and Green Waste collections', 1),
  ('Ancillary',       'anc',  'Mattress, E-Waste and Whitegoods collections', 2),
  ('Illegal Dumping', 'id',   'Ranger-created illegal dumping collections', 3);
```

#### `service`
```sql
-- Individual service types (was service in v1)
CREATE TABLE service (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  category_id  uuid NOT NULL REFERENCES category(id),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

#### `allocation_rules`
```sql
-- FY total allocation per collection_area per category (overall cap)
CREATE TABLE allocation_rules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_area_id    uuid NOT NULL REFERENCES collection_area(id) ON DELETE CASCADE,
  category_id           uuid NOT NULL REFERENCES category(id),
  max_collections       integer NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_area_id, category_id)
);
```

#### `service_rules`
```sql
-- Per-service sub-limit per collection_area + overage pricing (used for pricing)
CREATE TABLE service_rules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_area_id    uuid NOT NULL REFERENCES collection_area(id) ON DELETE CASCADE,
  service_id            uuid NOT NULL REFERENCES service(id),
  max_collections       integer NOT NULL,
  extra_unit_price      numeric NOT NULL DEFAULT 0,  -- AUD, inclusive of GST
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_area_id, service_id)
);
```

#### `financial_year`
```sql
CREATE TABLE financial_year (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label          text NOT NULL,          -- e.g. 'FY2025-26'
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  rollover_date  date NOT NULL,
  is_current     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Enforce single current FY via partial unique index
CREATE UNIQUE INDEX uidx_financial_year_current ON financial_year (is_current) WHERE is_current = true;
```

#### `eligible_properties`
```sql
CREATE TABLE eligible_properties (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_area_id    uuid NOT NULL REFERENCES collection_area(id),
  address               text NOT NULL,
  formatted_address     text,
  latitude              numeric,
  longitude             numeric,
  google_place_id       text,
  has_geocode           boolean NOT NULL DEFAULT false,
  is_mud                boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_eligible_properties_area ON eligible_properties(collection_area_id);
CREATE INDEX idx_eligible_properties_mud ON eligible_properties(collection_area_id) WHERE is_mud = true;
```

#### `strata_user_properties`
```sql
-- Junction: strata user → authorised MUD properties
CREATE TABLE strata_user_properties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  property_id   uuid NOT NULL REFERENCES eligible_properties(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, property_id)
);
```

#### `collection_date`
```sql
CREATE TABLE collection_date (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_area_id    uuid NOT NULL REFERENCES collection_area(id),
  date                  date NOT NULL,
  is_open               boolean NOT NULL DEFAULT true,
  for_mud               boolean NOT NULL DEFAULT false,
  -- Bulk capacity (General + Green)
  bulk_capacity_limit   integer NOT NULL DEFAULT 60,
  bulk_units_booked     integer NOT NULL DEFAULT 0,
  bulk_is_closed        boolean NOT NULL DEFAULT false,
  -- ANC capacity (Mattress + E-Waste + Whitegoods)
  anc_capacity_limit    integer NOT NULL DEFAULT 60,
  anc_units_booked      integer NOT NULL DEFAULT 0,
  anc_is_closed         boolean NOT NULL DEFAULT false,
  -- ID capacity (Illegal Dumping)
  id_capacity_limit     integer NOT NULL DEFAULT 10,
  id_units_booked       integer NOT NULL DEFAULT 0,
  id_is_closed          boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_area_id, date)
);
CREATE INDEX idx_collection_date_area_date ON collection_date(collection_area_id, date);
```

#### `booking`
```sql
CREATE TABLE booking (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                   text NOT NULL UNIQUE,
  type                  booking_type NOT NULL DEFAULT 'Residential',
  status                booking_status NOT NULL DEFAULT 'Submitted',
  property_id           uuid REFERENCES eligible_properties(id),
  contact_id            uuid REFERENCES contacts(id),
  collection_area_id    uuid NOT NULL REFERENCES collection_area(id),
  client_id             uuid NOT NULL REFERENCES client(id),
  contractor_id         uuid NOT NULL REFERENCES contractor(id),
  fy_id                 uuid NOT NULL REFERENCES financial_year(id),
  location              text,
  notes                 text,
  -- Geolocation (Illegal Dumping only)
  latitude              numeric,
  longitude             numeric,
  geo_address           text,
  -- Future crew-assignment field (nullable; the optimo_stop_id placeholder
  -- was dropped 02/07/2026 — stops use collection_stop.external_order_ref)
  crew_id               uuid,
  -- Audit
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  cancelled_at          timestamptz,
  cancelled_by          uuid REFERENCES profiles(id),
  cancellation_reason   text
);
CREATE INDEX idx_booking_client ON booking(client_id);
CREATE INDEX idx_booking_contractor ON booking(contractor_id);
CREATE INDEX idx_booking_collection_area ON booking(collection_area_id);
CREATE INDEX idx_booking_property ON booking(property_id);
CREATE INDEX idx_booking_contact ON booking(contact_id);
CREATE INDEX idx_booking_status ON booking(status);
CREATE INDEX idx_booking_ref ON booking(ref);
```

#### `booking_item`
```sql
CREATE TABLE booking_item (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  service_id      uuid NOT NULL REFERENCES service(id),
  collection_date_id   uuid NOT NULL REFERENCES collection_date(id),
  no_services          integer NOT NULL DEFAULT 1,      -- quantity booked
  actual_services      integer,                         -- filled by field staff (MUD)
  unit_price_cents     integer NOT NULL DEFAULT 0,      -- 0 = included in allocation
  is_extra             boolean NOT NULL DEFAULT false,  -- true = charged
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_booking_item_booking ON booking_item(booking_id);
CREATE INDEX idx_booking_item_collection_date ON booking_item(collection_date_id);
```

#### `booking_payment`
```sql
CREATE TABLE booking_payment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  client_id             uuid NOT NULL REFERENCES client(id),   -- for future Stripe Connect
  contractor_id         uuid NOT NULL REFERENCES contractor(id),
  stripe_session_id     text NOT NULL UNIQUE,
  stripe_payment_intent text,
  stripe_charge_id      text,
  amount_cents          integer NOT NULL,
  currency              text NOT NULL DEFAULT 'aud',
  status                text NOT NULL DEFAULT 'pending',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
```

#### `refund_request`
```sql
CREATE TABLE refund_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid NOT NULL REFERENCES booking(id),
  contact_id        uuid NOT NULL REFERENCES contacts(id),
  client_id         uuid NOT NULL REFERENCES client(id),
  amount_cents      integer NOT NULL,
  reason            text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'Pending',
  stripe_refund_id  text,
  reviewed_by       uuid REFERENCES profiles(id),
  reviewed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
```

#### `non_conformance_notice`
```sql
CREATE TABLE non_conformance_notice (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id              uuid NOT NULL REFERENCES booking(id),
  client_id               uuid NOT NULL REFERENCES client(id),
  reason                  ncn_reason NOT NULL,
  notes                   text,
  photos                  text[] NOT NULL DEFAULT '{}',
  status                  ncn_status NOT NULL DEFAULT 'Open',
  reported_by             uuid REFERENCES profiles(id),
  reported_at             timestamptz NOT NULL DEFAULT now(),
  resolved_by             uuid REFERENCES profiles(id),
  resolved_at             timestamptz,
  resolution_notes        text,
  rescheduled_booking_id  uuid REFERENCES booking(id),
  rescheduled_date        date,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
```

#### `nothing_presented`
```sql
CREATE TABLE nothing_presented (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id              uuid NOT NULL REFERENCES booking(id),
  client_id               uuid NOT NULL REFERENCES client(id),
  notes                   text,
  photos                  text[] NOT NULL DEFAULT '{}',
  status                  np_status NOT NULL DEFAULT 'Open',
  dm_fault                boolean NOT NULL DEFAULT false,
  reported_by             uuid REFERENCES profiles(id),
  reported_at             timestamptz NOT NULL DEFAULT now(),
  resolved_by             uuid REFERENCES profiles(id),
  resolved_at             timestamptz,
  resolution_notes        text,
  rescheduled_booking_id  uuid REFERENCES booking(id),
  rescheduled_date        date,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
```

#### `service_ticket`
```sql
CREATE TABLE service_ticket (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_id        text NOT NULL UNIQUE,
  client_id         uuid NOT NULL REFERENCES client(id),
  booking_id        uuid REFERENCES booking(id),
  contact_id        uuid NOT NULL REFERENCES contacts(id),
  subject           text NOT NULL,
  message           text NOT NULL,
  status            ticket_status NOT NULL DEFAULT 'open',
  priority          ticket_priority NOT NULL DEFAULT 'normal',
  category          ticket_category NOT NULL DEFAULT 'general',
  channel           ticket_channel NOT NULL DEFAULT 'portal',
  assigned_to       uuid REFERENCES profiles(id),
  first_response_at timestamptz,
  resolved_at       timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_ticket_client ON service_ticket(client_id);
CREATE INDEX idx_service_ticket_contact ON service_ticket(contact_id);
```

#### `ticket_response`
```sql
CREATE TABLE ticket_response (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES service_ticket(id) ON DELETE CASCADE,
  author_id    uuid NOT NULL REFERENCES profiles(id),
  author_type  text NOT NULL,   -- 'staff' | 'resident'
  message      text NOT NULL,
  is_internal  boolean NOT NULL DEFAULT false,
  channel      text NOT NULL DEFAULT 'portal',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

#### `sla_config`
```sql
CREATE TABLE sla_config (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid NOT NULL REFERENCES client(id),
  priority              ticket_priority NOT NULL,
  first_response_hours  integer NOT NULL DEFAULT 24,
  resolution_hours      integer NOT NULL DEFAULT 72,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, priority)
);
```

#### `notification_log`
```sql
CREATE TABLE notification_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            uuid REFERENCES booking(id),
  contact_id            uuid REFERENCES contacts(id),
  client_id             uuid NOT NULL REFERENCES client(id),
  channel               text NOT NULL,
  notification_type     text NOT NULL,
  to_address            text NOT NULL,
  status                text NOT NULL DEFAULT 'sent',
  error_message         text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notification_log_booking ON notification_log(booking_id);
```

#### `booking_survey`
```sql
CREATE TABLE booking_survey (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL UNIQUE REFERENCES booking(id),
  client_id    uuid NOT NULL REFERENCES client(id),
  token        text NOT NULL UNIQUE,
  submitted_at timestamptz,
  responses    jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_booking_survey_token ON booking_survey(token);
```

#### `tenant_survey_config`
```sql
CREATE TABLE client_survey_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  questions   jsonb NOT NULL DEFAULT '[]',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id)
);
```

#### `app_module`
```sql
CREATE TABLE app_module (
  id          text PRIMARY KEY,    -- e.g. 'v-bookings'
  name        text NOT NULL,
  app         text NOT NULL,       -- 'verco' | 'dm-ops'
  category    text NOT NULL,
  icon        text,
  route       text,
  sort_order  integer NOT NULL DEFAULT 0
);
```

#### `role_permissions`
```sql
CREATE TABLE role_permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role        app_role NOT NULL,
  module_id   text NOT NULL REFERENCES app_module(id),
  action      app_permission_action NOT NULL,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE (role, module_id, action)
);
```

#### `audit_log`
```sql
CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name   text NOT NULL,
  record_id    uuid NOT NULL,
  action       text NOT NULL,
  old_data     jsonb,
  new_data     jsonb,
  changed_by   uuid REFERENCES profiles(id),
  client_id    uuid REFERENCES client(id),
  contractor_id uuid REFERENCES contractor(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_record ON audit_log(table_name, record_id);
CREATE INDEX idx_audit_log_client ON audit_log(client_id);
```

#### `bug_report`
```sql
CREATE TABLE bug_report (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_id            text NOT NULL UNIQUE,
  title                 text NOT NULL,
  source_app            text NOT NULL,
  category              bug_report_category NOT NULL DEFAULT 'other',
  priority              bug_report_priority NOT NULL DEFAULT 'medium',
  status                bug_report_status NOT NULL DEFAULT 'new',
  reporter_id           uuid NOT NULL REFERENCES profiles(id),
  assigned_to           uuid REFERENCES profiles(id),
  client_id             uuid REFERENCES client(id),
  collection_area_id    uuid REFERENCES collection_area(id),
  page_url              text,
  browser_info          text,
  linear_issue_id       text,
  linear_issue_url      text,
  resolved_at           timestamptz,
  resolution_notes      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
```

#### `sync_log`
```sql
CREATE TABLE sync_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  direction        text NOT NULL,   -- 'outbound' | 'inbound'
  status           text NOT NULL DEFAULT 'success',
  error_message    text,
  payload          jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

---

## 4. Removed Tables (v1 → v2)

The following prototype tables are **not present in Verco v2**:

**Moved to DM-Ops:**
`docket`, `timesheet`, `employee`, `crew`, `asset`, `disposal_facility`, `waste_type`, `booked_collection`, `invoice`, `invoice_line_item`, `xero_code`, `tender`, `tender_document`, `tender_sequence`, `purchase_order`, `project`, `eh_certifications`, `eh_employee_certifications`

**Replaced by new hierarchy:**
`tenant`, `tenant_branding`, `account`, `job`, `area`, `account_job_area` → replaced by `contractor`, `client`, `sub_client`, `collection_area`

**Renamed:**

| v1 name | v2 name |
|---|---|
| `booking_enquiry` | `service_ticket` |
| `enquiry_response` | `ticket_response` |
| `tenant_survey_config` | `client_survey_config` |

---

## 5. Auth Architecture

### 5.1 Auth Provider

Supabase Auth, email OTP only. No passwords. No OAuth.

### 5.2 Session Strategy

JWT persisted in cookies (not localStorage) for server component compatibility. `@supabase/ssr` package handles cookie-based sessions.

### 5.3 Middleware Flow

```
Request
  └── middleware.ts
        ├── 1. Resolve tenant from hostname
        │     ├── Check request hostname against tenant.slug + tenant.custom_domain
        │     ├── Store tenant_id in request headers (x-tenant-id)
        │     └── 404 if no matching tenant
        ├── 2. Validate session (Supabase Auth)
        │     └── Refresh token if needed
        └── 3. Route guards
              ├── /admin/* → requires role IN ('admin', 'staff')
              ├── /field/* → requires role IN ('field', 'ranger')
              └── /dashboard, /booking/* → requires authenticated session
```

### 5.4 Client (Portal) Resolution

```typescript
// lib/tenant/resolve.ts
export async function resolveClient(hostname: string): Promise<Client | null> {
  const slug = hostname.split('.')[0]  // vergevalet.verco.au → 'vergevalet'
  
  const { data } = await supabase
    .from('client')
    .select('*, contractor(*)')
    .or(`slug.eq.${slug},custom_domain.eq.${hostname}`)
    .eq('is_active', true)
    .single()
  
  return data
}
```

### 5.5 Post-Signup Trigger

On `auth.users` INSERT, a DB trigger creates a `profiles` record and assigns the `resident` role scoped to the client resolved from signup metadata:

```sql
CREATE OR REPLACE FUNCTION assign_resident_role_on_signup()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  
  INSERT INTO public.user_roles (user_id, role, client_id)
  VALUES (
    NEW.id,
    'resident',
    (NEW.raw_user_meta_data->>'client_id')::uuid
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## 6. Row Level Security (RLS)

### 6.1 RLS Helpers

```sql
-- Returns current user's role
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS app_role AS $$
  SELECT role FROM user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Returns current user's contractor_id (for contractor-tier roles)
CREATE OR REPLACE FUNCTION current_user_contractor_id()
RETURNS uuid AS $$
  SELECT contractor_id FROM user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Returns current user's client_id (for client-tier roles)
CREATE OR REPLACE FUNCTION current_user_client_id()
RETURNS uuid AS $$
  SELECT client_id FROM user_roles WHERE user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Returns current user's contact_id
CREATE OR REPLACE FUNCTION current_user_contact_id()
RETURNS uuid AS $$
  SELECT contact_id FROM profiles WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Check if current user has a given role
CREATE OR REPLACE FUNCTION has_role(check_role app_role)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = auth.uid() AND role = check_role AND is_active = true
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Is the current user a contractor-tier user?
CREATE OR REPLACE FUNCTION is_contractor_user()
RETURNS boolean AS $$
  SELECT current_user_role() IN ('contractor-admin', 'contractor-staff', 'field');
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Is the current user a client-tier admin/staff?
CREATE OR REPLACE FUNCTION is_client_staff()
RETURNS boolean AS $$
  SELECT current_user_role() IN ('client-admin', 'client-staff');
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Is the current user a field role (field or ranger)?
CREATE OR REPLACE FUNCTION is_field_user()
RETURNS boolean AS $$
  SELECT current_user_role() IN ('field', 'ranger');
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Returns all client_ids accessible to the current user
-- Contractor users: all clients under their contractor
-- Client users: their own client only
CREATE OR REPLACE FUNCTION accessible_client_ids()
RETURNS SETOF uuid AS $$
  SELECT CASE
    WHEN is_contractor_user() THEN
      (SELECT id FROM client WHERE contractor_id = current_user_contractor_id())
    ELSE
      current_user_client_id()
  END;
$$ LANGUAGE sql SECURITY DEFINER STABLE;
```

### 6.2 RLS Policy Design

**Enable RLS on all tables:**
```sql
ALTER TABLE tenant              ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_branding     ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking             ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_item        ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_payment     ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_request      ENABLE ROW LEVEL SECURITY;
ALTER TABLE non_conformance_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE nothing_presented   ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_ticket      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_response     ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_date     ENABLE ROW LEVEL SECURITY;
ALTER TABLE eligible_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE strata_user_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_survey      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE bug_report          ENABLE ROW LEVEL SECURITY;
```

**Key policies:**

```sql
-- BOOKING: Residents see own bookings only
CREATE POLICY booking_resident_select ON booking FOR SELECT
  USING (
    contact_id = current_user_contact_id()
    AND current_user_role() = 'resident'
  );

-- BOOKING: Contractor users see all bookings across all their clients
CREATE POLICY booking_contractor_select ON booking FOR SELECT
  USING (
    contractor_id = current_user_contractor_id()
    AND is_contractor_user()
  );

-- BOOKING: Client staff see bookings within their client
CREATE POLICY booking_client_staff_select ON booking FOR SELECT
  USING (
    client_id = current_user_client_id()
    AND is_client_staff()
  );

-- BOOKING: Field/Ranger see bookings within accessible clients — contacts join blocked
CREATE POLICY booking_field_select ON booking FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND is_field_user()
  );

-- CONTACTS: Residents see own contact only
CREATE POLICY contacts_resident_select ON contacts FOR SELECT
  USING (
    id = current_user_contact_id()
    AND current_user_role() = 'resident'
  );

-- CONTACTS: Contractor staff see contacts for bookings under their contractor
CREATE POLICY contacts_contractor_select ON contacts FOR SELECT
  USING (
    is_contractor_user()
    AND EXISTS (
      SELECT 1 FROM booking b
      WHERE b.contact_id = contacts.id
      AND b.contractor_id = current_user_contractor_id()
    )
  );

-- CONTACTS: Client staff see contacts for bookings under their client
CREATE POLICY contacts_client_staff_select ON contacts FOR SELECT
  USING (
    is_client_staff()
    AND EXISTS (
      SELECT 1 FROM booking b
      WHERE b.contact_id = contacts.id
      AND b.client_id = current_user_client_id()
    )
  );

-- CONTACTS: Field and Ranger — NO access (no policy = no access with RLS enabled)

-- COLLECTION_DATE: Contractor users see all dates across their clients
CREATE POLICY collection_date_contractor_select ON collection_date FOR SELECT
  USING (
    collection_area_id IN (
      SELECT id FROM collection_area WHERE contractor_id = current_user_contractor_id()
    )
    AND is_contractor_user()
  );

-- COLLECTION_DATE: Authenticated users see dates for their client's areas
CREATE POLICY collection_date_client_select ON collection_date FOR SELECT
  USING (
    collection_area_id IN (
      SELECT id FROM collection_area WHERE client_id IN (SELECT accessible_client_ids())
    )
  );

-- COLLECTION_DATE: Only contractor-admin can INSERT/UPDATE/DELETE
CREATE POLICY collection_date_contractor_write ON collection_date FOR ALL
  USING (has_role('contractor-admin'))
  WITH CHECK (has_role('contractor-admin'));

-- ELIGIBLE_PROPERTIES: Authenticated users see properties for their accessible clients
CREATE POLICY eligible_properties_select ON eligible_properties FOR SELECT
  USING (
    collection_area_id IN (
      SELECT id FROM collection_area WHERE client_id IN (SELECT accessible_client_ids())
    )
  );

-- BOOKING: Resident INSERT own bookings
CREATE POLICY booking_resident_insert ON booking FOR INSERT
  WITH CHECK (
    current_user_role() IN ('resident', 'strata')
    AND contact_id = current_user_contact_id()
  );

-- BOOKING: Resident UPDATE own pre-Scheduled bookings
CREATE POLICY booking_resident_update ON booking FOR UPDATE
  USING (
    contact_id = current_user_contact_id()
    AND status NOT IN ('Scheduled', 'Completed', 'Cancelled')
  );

-- BOOKING: Field can UPDATE status (Scheduled → terminal states only)
CREATE POLICY booking_field_update ON booking FOR UPDATE
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND has_role('field')
    AND status = 'Scheduled'
  )
  WITH CHECK (
    status IN ('Completed', 'Non-conformance', 'Nothing Presented')
  );

-- SERVICE_TICKET: Residents see own tickets
CREATE POLICY service_ticket_resident_select ON service_ticket FOR SELECT
  USING (
    contact_id = current_user_contact_id()
    AND current_user_role() = 'resident'
  );

-- SERVICE_TICKET: Client and contractor staff see tickets within accessible clients
CREATE POLICY service_ticket_staff_select ON service_ticket FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (is_client_staff() OR is_contractor_user())
  );

-- NCN: Field can INSERT for accessible clients
CREATE POLICY ncn_field_insert ON non_conformance_notice FOR INSERT
  WITH CHECK (
    client_id IN (SELECT accessible_client_ids())
    AND has_role('field')
  );

-- AUDIT_LOG: client-admin sees own client, contractor-admin sees all their clients
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (has_role('client-admin') OR has_role('contractor-admin'))
  );
```

---

## 7. Pricing Engine

### 7.1 Location

Server-side only. Lives in `supabase/functions/calculate-price/index.ts` and `lib/pricing/calculate.ts`. Never exposed to client.

### 7.2 Input Schema (zod)

```typescript
const BookingItemInput = z.object({
  service_id:    z.string().uuid(),
  collection_date_id: z.string().uuid(),
  quantity:           z.number().int().min(1).max(10),
})

const PriceCalculationRequest = z.object({
  property_id:  z.string().uuid(),
  fy_id:        z.string().uuid(),
  items:        z.array(BookingItemInput).min(1).max(20),
})
```

### 7.3 Algorithm

```typescript
async function calculatePrice(
  req: PriceCalculationRequest,
  supabase: SupabaseClient
): Promise<PriceCalculationResult> {
  
  // 1. Get property → AJA
  const { data: property } = await supabase
    .from('eligible_properties')
    .select('account_job_area_id')
    .eq('id', req.property_id)
    .single()

  // 2. Get service rules for this AJA
  const { data: rules } = await supabase
    .from('service_rules')
    .select('service_id, max_collections, extra_unit_price')
    .eq('account_job_area_id', property.account_job_area_id)

  // 3. Get FY usage per service type for this property
  const { data: usage } = await supabase
    .from('booking_item')
    .select('service_id, no_services, booking!inner(status, fy_id, property_id)')
    .eq('booking.property_id', req.property_id)
    .eq('booking.fy_id', req.fy_id)
    .not('booking.status', 'in', '("Cancelled","Pending Payment")')

  // 4. Aggregate usage per service type
  const usageMap = usage.reduce((acc, item) => {
    acc[item.service_id] = (acc[item.service_id] || 0) + item.no_services
    return acc
  }, {} as Record<string, number>)

  // 5. Calculate per item
  const lineItems = req.items.map(item => {
    const rule = rules.find(r => r.service_id === item.service_id)
    const alreadyUsed = usageMap[item.service_id] || 0
    const maxFree = rule?.max_collections ?? 0
    const remainingFree = Math.max(0, maxFree - alreadyUsed)
    const freeUnits = Math.min(item.quantity, remainingFree)
    const paidUnits = item.quantity - freeUnits
    const unitPriceCents = Math.round((rule?.extra_unit_price ?? 0) * 100)
    const lineChargeCents = paidUnits * unitPriceCents

    return {
      service_id:   item.service_id,
      collection_date_id: item.collection_date_id,
      quantity:          item.quantity,
      free_units:        freeUnits,
      paid_units:        paidUnits,
      unit_price_cents:  unitPriceCents,
      line_charge_cents: lineChargeCents,
      is_extra:          paidUnits > 0,
    }
  })

  const totalCents = lineItems.reduce((sum, l) => sum + l.line_charge_cents, 0)

  return { line_items: lineItems, total_cents: totalCents }
}
```

### 7.4 Output Schema

```typescript
type PriceCalculationResult = {
  line_items: {
    service_id:    string
    collection_date_id: string
    quantity:           number
    free_units:         number
    paid_units:         number
    unit_price_cents:   number
    line_charge_cents:  number
    is_extra:           boolean
  }[]
  total_cents: number   // 0 = no Stripe checkout required
}
```

---

## 8. Booking State Machine

### 8.1 DB-Level Enforcement

```sql
CREATE OR REPLACE FUNCTION enforce_booking_state_transition()
RETURNS TRIGGER AS $$
DECLARE
  valid boolean := false;
BEGIN
  -- Define valid transitions
  valid := CASE
    WHEN OLD.status = 'Pending Payment'   AND NEW.status = 'Submitted'           THEN true
    WHEN OLD.status = 'Pending Payment'   AND NEW.status = 'Cancelled'            THEN true
    WHEN OLD.status = 'Submitted'         AND NEW.status = 'Confirmed'            THEN true
    WHEN OLD.status = 'Submitted'         AND NEW.status = 'Cancelled'            THEN true
    WHEN OLD.status = 'Confirmed'         AND NEW.status = 'Scheduled'            THEN true
    WHEN OLD.status = 'Confirmed'         AND NEW.status = 'Cancelled'            THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Completed'            THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Non-conformance'      THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Nothing Presented'    THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Cancelled'            THEN true  -- admin override only
    WHEN OLD.status = 'Non-conformance'   AND NEW.status = 'Rescheduled'          THEN true
    WHEN OLD.status = 'Nothing Presented' AND NEW.status = 'Rebooked'             THEN true
    ELSE false
  END;

  IF NOT valid THEN
    RAISE EXCEPTION 'Invalid booking status transition: % → %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER booking_state_machine
  BEFORE UPDATE OF status ON booking
  FOR EACH ROW
  EXECUTE FUNCTION enforce_booking_state_transition();
```

### 8.2 Cancellation Cutoff

```sql
CREATE OR REPLACE FUNCTION enforce_cancellation_cutoff()
RETURNS TRIGGER AS $$
DECLARE
  collection_date date;
  cutoff timestamptz;
BEGIN
  IF NEW.status = 'Cancelled' AND OLD.status NOT IN ('Pending Payment', 'Submitted') THEN
    -- Get earliest collection date for this booking
    SELECT MIN(cd.date) INTO collection_date
    FROM booking_item bi
    JOIN collection_date cd ON cd.id = bi.collection_date_id
    WHERE bi.booking_id = NEW.id;

    -- Cutoff is 3:30pm AWST (UTC+8) the day before collection
    cutoff := (collection_date - interval '1 day')::timestamptz
              + interval '7 hours 30 minutes';  -- 15:30 AWST = 07:30 UTC

    IF now() > cutoff THEN
      RAISE EXCEPTION 'Cancellation cutoff has passed for booking %', NEW.ref;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### 8.3 Scheduled Transition (Daily Cron)

A Supabase cron job fires daily at 07:25 UTC (3:25pm AWST) — 5 minutes before the cutoff:

```sql
SELECT cron.schedule(
  'transition-to-scheduled',
  '25 7 * * *',  -- 3:25pm AWST daily
  $$
    UPDATE booking
    SET status = 'Scheduled'
    WHERE status = 'Confirmed'
    AND id IN (
      SELECT DISTINCT bi.booking_id
      FROM booking_item bi
      JOIN collection_date cd ON cd.id = bi.collection_date_id
      WHERE cd.date = CURRENT_DATE + 1
    );
  $$
);
```

---

## 9. Capacity Management

### 9.1 Concurrency Control

Capacity validation and booking insert are wrapped in a serialisable transaction using a Postgres advisory lock keyed on `collection_date_id`:

```sql
-- In the create-booking Edge Function, called via RPC
CREATE OR REPLACE FUNCTION create_booking_with_capacity_check(
  p_collection_date_id uuid,
  p_category_code text,
  p_units integer,
  -- ... other booking params
)
RETURNS uuid AS $$
DECLARE
  v_lock_key bigint;
  v_available integer;
  v_booking_id uuid;
BEGIN
  -- Advisory lock keyed on collection_date_id
  v_lock_key := ('x' || substr(p_collection_date_id::text, 1, 8))::bit(32)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Check capacity
  SELECT 
    CASE p_bucket
      WHEN 'bulk' THEN bulk_capacity_limit - bulk_units_booked
      WHEN 'anc'  THEN anc_capacity_limit - anc_units_booked
      WHEN 'id'   THEN id_capacity_limit - id_units_booked
    END INTO v_available
  FROM collection_date WHERE id = p_collection_date_id;

  IF v_available < p_units THEN
    RAISE EXCEPTION 'Insufficient capacity on collection date';
  END IF;

  -- Insert booking and items (capacity recalculated via trigger)
  -- ... booking INSERT logic

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql;
```

### 9.2 Capacity Recalculation Trigger

```sql
CREATE OR REPLACE FUNCTION recalculate_collection_date_units()
RETURNS TRIGGER AS $$
BEGIN
  -- Recalculate all bucket totals for the affected collection_date
  UPDATE collection_date cd
  SET
    bulk_units_booked = (
      SELECT COALESCE(SUM(bi.no_services), 0)
      FROM booking_item bi
      JOIN booking b ON b.id = bi.booking_id
      JOIN service st ON st.id = bi.service_id
      JOIN category c ON c.id = st.category_id
      WHERE bi.collection_date_id = cd.id
      AND c.code = 'bulk'
      AND b.status NOT IN ('Cancelled', 'Pending Payment')
    ),
    anc_units_booked = (
      SELECT COALESCE(SUM(bi.no_services), 0)
      FROM booking_item bi
      JOIN booking b ON b.id = bi.booking_id
      JOIN service st ON st.id = bi.service_id
      JOIN category c ON c.id = st.category_id
      WHERE bi.collection_date_id = cd.id
      AND c.code = 'anc'
      AND b.status NOT IN ('Cancelled', 'Pending Payment')
    ),
    id_units_booked = (
      SELECT COALESCE(SUM(bi.no_services), 0)
      FROM booking_item bi
      JOIN booking b ON b.id = bi.booking_id
      JOIN service st ON st.id = bi.service_id
      JOIN category c ON c.id = st.category_id
      WHERE bi.collection_date_id = cd.id
      AND c.code = 'id'
      AND b.status NOT IN ('Cancelled', 'Pending Payment')
    )
  WHERE cd.id = COALESCE(NEW.collection_date_id, OLD.collection_date_id);

  -- Recalculate is_closed flags
  UPDATE collection_date
  SET
    bulk_is_closed = (bulk_units_booked >= bulk_capacity_limit),
    anc_is_closed  = (anc_units_booked >= anc_capacity_limit),
    id_is_closed   = (id_units_booked >= id_capacity_limit)
  WHERE id = COALESCE(NEW.collection_date_id, OLD.collection_date_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recalculate_units
  AFTER INSERT OR UPDATE OR DELETE ON booking_item
  FOR EACH ROW EXECUTE FUNCTION recalculate_collection_date_units();
```

---

## 10. Edge Function Contracts

All Edge Functions are in `supabase/functions/`. Auth pattern: Bearer JWT unless noted.

### `calculate-price`
- **Auth:** Bearer JWT
- **Input:** `PriceCalculationRequest` (see §7.2)
- **Output:** `PriceCalculationResult` (see §7.4)
- **Side effects:** None — read only

### `create-booking`
- **Auth:** Bearer JWT
- **Input:** `{ property_id, items, contact, location, notes, price_result }`
- **Validates:** Re-runs `calculatePrice` server-side — ignores any client-supplied `unit_price_cents`
- **Calls:** `create_booking_with_capacity_check` RPC (serialised)
- **Output:** `{ booking_id, ref, requires_payment: boolean, checkout_url? }`
- **Side effects:** Inserts `booking`, `booking_item`, `contacts` (upsert), triggers notifications

### `create-checkout`
- **Auth:** Bearer JWT
- **Input:** `{ booking_id }`
- **Validates:** Booking belongs to calling user, status = `Pending Payment`
- **Output:** `{ checkout_url }` (Stripe Checkout Session)
- **Side effects:** Creates Stripe Checkout Session

### `verify-payment`
- **Auth:** Bearer JWT
- **Input:** `{ session_id }`
- **Output:** `{ booking_id, status }`
- **Side effects:** Updates `booking_payment.status`, transitions `booking.status` to `Submitted`

### `stripe-webhook`
- **Auth:** Stripe HMAC signature verification
- **Handles:** `checkout.session.completed`, `charge.refunded`
- **Side effects:** Updates `booking_payment`, `booking.status`, `refund_request.status`

### `process-refund`
- **Auth:** Bearer JWT (DM-Ops service role only)
- **Input:** `{ refund_request_id }`
- **Output:** `{ stripe_refund_id }`
- **Side effects:** Initiates Stripe refund, updates `refund_request`

### `send-email`
- **Auth:** Internal (service role)
- **Input:** `{ template, to, booking_id?, tenant_id?, data }`
- **Templates:** `booking_created`, `booking_updated`, `booking_cancelled`, `place_out_reminder`, `ncn_raised`, `np_raised`, `collection_completed`, `refund_confirmed`
- **Side effects:** Sends email, inserts `notification_log`

### `send-sms`
- **Auth:** Internal (service role)
- **Input:** `{ template, to_e164, booking_id?, tenant_id?, data }`
- **Templates:** `booking_created`, `place_out_reminder`
- **Side effects:** Sends SMS, inserts `notification_log`

### `send-place-out-reminders`
- **Auth:** Cron (daily)
- **Trigger:** Supabase cron, daily at 06:00 UTC
- **Logic:** Find all bookings where `collection_date = today + sms_reminder_days_before` AND no `place_out_reminder` in `notification_log`
- **Side effects:** Calls `send-email` + `send-sms` for each eligible booking

### `google-places-proxy`
- **Auth:** Bearer JWT
- **Input:** `{ input, session_token }`
- **Output:** Google Places Autocomplete results (filtered to AJA bounds)
- **Side effects:** None

### `geocode-property`
- **Auth:** Bearer JWT (admin only)
- **Input:** `{ property_id }`
- **Side effects:** Updates `eligible_properties.latitude`, `longitude`, `has_geocode`

### `nightly-sync-to-dm-ops`
- **Auth:** Service role (cron)
- **Trigger:** Supabase cron, daily at 20:00 AWST (12:00 UTC)
- **Logic:** Aggregate attended bookings (`status IN ('Completed','Non-conformance','Nothing Presented')`) grouped by `collection_area.dm_job_code + collection_date + client_id`
- **Output:** Upserts aggregate records into DM-Ops Supabase project via service role key
- **Side effects:** Inserts/updates `booked_collection` in DM-Ops DB keyed on `dm_job_code + date`

---

## 11. White-Label & Tenant Resolution

### 11.1 Middleware Client Resolution

```typescript
// middleware.ts
export async function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') ?? ''
  const client = await resolveClient(hostname)
  
  if (!client) {
    return NextResponse.rewrite(new URL('/404', request.url))
  }
  
  const response = NextResponse.next()
  response.headers.set('x-client-id', client.id)
  response.headers.set('x-client-slug', client.slug)
  response.headers.set('x-contractor-id', client.contractor_id)
  return response
}
```

### 11.2 Branding Keys

Branding is stored as columns on the `client` table (not a separate key-value table). Fallbacks for nullable fields are defined in `lib/client/branding-defaults.ts`.

| Column | Type | Required | Notes |
|---|---|---|---|
| `logo_light_url` | text | Yes | |
| `logo_dark_url` | text | No | |
| `primary_colour` | text | Yes | Hex string |
| `service_name` | text | Yes | e.g. "Verge Collection Bookings" |
| `hero_banner_url` | text | No | |
| `show_powered_by` | boolean | Yes | Default true — "Powered by Verco" badge |
| `landing_headline` | text | No | |
| `landing_subheading` | text | No | |
| `contact_name` | text | No | |
| `contact_phone` | text | No | |
| `contact_email` | text | No | |
| `privacy_policy_url` | text | No | |
| `email_footer_html` | text | No | |
| `faq_items` | jsonb | No | `[{question, answer}]` |

---

## 12. Run Sheet Query

Run sheet is a derived query, not a stored entity. Served from a Supabase RPC function:

```sql
CREATE OR REPLACE FUNCTION get_run_sheet(
  p_collection_date_id uuid,
  p_client_id          uuid
)
RETURNS TABLE (
  booking_id            uuid,
  booking_ref           text,
  booking_type          booking_type,
  booking_status        booking_status,
  formatted_address     text,
  latitude              numeric,
  longitude             numeric,
  location_on_property  text,
  notes                 text,
  service_name     text,
  no_services           integer,
  actual_services       integer,
  has_ncn               boolean,
  has_np                boolean,
  google_maps_url       text
) AS $$
  SELECT
    b.id,
    b.ref,
    b.type,
    b.status,
    COALESCE(ep.formatted_address, b.geo_address)  AS formatted_address,
    COALESCE(ep.latitude, b.latitude)              AS latitude,
    COALESCE(ep.longitude, b.longitude)            AS longitude,
    b.location,
    b.notes,
    st.name,
    bi.no_services,
    bi.actual_services,
    EXISTS (SELECT 1 FROM non_conformance_notice WHERE booking_id = b.id) AS has_ncn,
    EXISTS (SELECT 1 FROM nothing_presented WHERE booking_id = b.id)      AS has_np,
    'https://maps.google.com/?q=' || COALESCE(ep.latitude, b.latitude)::text
      || ',' || COALESCE(ep.longitude, b.longitude)::text                 AS google_maps_url
  FROM booking_item bi
  JOIN booking b ON b.id = bi.booking_id
  JOIN service st ON st.id = bi.service_id
  LEFT JOIN eligible_properties ep ON ep.id = b.property_id
  WHERE bi.collection_date_id = p_collection_date_id
  AND b.client_id = p_client_id
  AND b.status NOT IN ('Cancelled', 'Pending Payment')
  ORDER BY ep.formatted_address;
$$ LANGUAGE sql SECURITY DEFINER;
```

**Note:** No contact fields (`full_name`, `email`, `mobile_e164`) are returned. PII suppression is structural — the field is not in the query, not filtered at the application layer.

---

## 13. Survey System

_As-built, reconciled 2026-07-04 (shipped #284/#285/#287/#288). The original 1.0 design (DB trigger + `/api/survey` route + per-tenant `client_survey_config`) was superseded — see Change Log. Full detail: memory `survey-public-access-pipeline.md`._

### 13.1 Survey Creation

Survey rows are **not** created by a DB trigger — the legacy `create_survey_on_completion` trigger was dropped (`20260610120000`; it ran as the invoking role and violated `booking_survey` RLS). The field closeout server action creates the row when the final `collection_stop` closes and the rollup lands the booking on `Completed`:

- `maybeCreateCompletionSurvey(supabase, bookingId, clientId)` in `app/(field)/field/stops/[id]/actions.ts` inserts `booking_survey (booking_id, client_id, token)` with `token = crypto.randomUUID()` (unguessable, `UNIQUE`), then sends the `completion_survey` email via `invokeSendNotification`.
- Guarded: only when `booking.status = 'Completed'`, only once (existence check + `UNIQUE (booking_id)`), and behind the `DISABLE_SURVEY_EMAIL` env kill-switch.

### 13.2 Public Token Access (RPCs)

`/survey/[token]` is a public route (no auth) on a **standalone layout** (`HideOnSurvey` strips the resident app chrome). The logged-out page cannot touch `booking_survey` directly — RLS has no anon SELECT and no UPDATE. Two anon-callable `SECURITY DEFINER` RPCs (migration `20260704000000`, `search_path` pinned, anon EXECUTE intentional — do NOT revoke) are the access layer:

- `get_survey_by_token(p_token text) RETURNS jsonb` — `{ submitted, booking_ref, collection_date, service_chips[] }`, computed inside the definer. `NULL` for an unknown token → `notFound()`; never returns prior responses.
- `submit_survey_by_token(p_token text, p_responses jsonb) RETURNS jsonb` — `SELECT ... FOR UPDATE` (single-submission), structural guards, writes `responses` + `submitted_at`.

Survey questions are a **fixed shared code constant** `SURVEY_QUESTIONS` (`src/lib/survey/questions.ts`) — the ids are stable analytics keys, not loaded from `client_survey_config` (defined but unwired; per-tenant custom questions deferred).

### 13.3 Submission

The public `submitSurvey` server action validates responses against `SURVEY_QUESTIONS` (`validateResponses` — server-authoritative: unknown keys, required, rating range, option membership), then calls `submit_survey_by_token`. There is no `/api/survey` route.

### 13.4 Admin + Reporting

`/admin/surveys` (list / detail / CSV export / aggregate summary) is staff-scoped via the `booking_survey_staff_select` RLS policy (excludes field/ranger). Response rate is computed against **completed bookings** (not surveys-created) with a data-quality gap flag; a "Recent Survey Feedback" card surfaces on the admin dashboard.

---

## 14. Storage Buckets

| Bucket | Public | Purpose | Access |
|---|---|---|---|
| `ncn-photos` | false | NCN incident photos | `field` INSERT, `admin`/`staff` SELECT |
| `np-photos` | false | NP incident photos | `field` INSERT, `admin`/`staff` SELECT |
| `bug-report-attachments` | false | Bug report screenshots | Reporter INSERT, `admin` SELECT |
| `tenant-assets` | true | Logos, hero banners | `admin` INSERT per tenant, public SELECT |

> `po-documents` bucket is not present in Verco v2 (DM-Ops concern).

---

## 15. Testing Requirements

| Layer | Tool | Coverage target |
|---|---|---|
| Pricing engine | Vitest | 100% — all allocation scenarios |
| State machine | Vitest | 100% — all valid + invalid transitions |
| RLS policies | Supabase local + Vitest | Key policies per role |
| Edge Functions | Vitest | Core logic unit tests |
| Booking wizard E2E | Playwright | Free booking, paid booking, mixed cart |
| Auth flow E2E | Playwright | OTP login, session expiry |

### Critical Unit Test Cases — Pricing

```
- Property with 0 previous usage, 1 free allocation → free
- Property with 1/1 used, requesting 1 → 1 paid
- Property with 0/2 used, requesting 3 → 2 free + 1 paid
- Two service types, one exhausted, one not → mixed cart
- Different AJA rules (KWN vs COT) produce different results for same request
- MUD booking → always $0
- ID booking → always $0
```

### Critical Unit Test Cases — State Machine

```
- Pending Payment → Submitted ✓
- Pending Payment → Confirmed ✗ (invalid)
- Confirmed → Scheduled ✓
- Scheduled → Completed ✓
- Scheduled → Cancelled ✗ (cutoff enforced)
- Completed → Cancelled ✗ (invalid)
```

---

## 16. Environment Variables

```bash
# Supabase (Verco project)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # server/edge only

# Stripe
STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=                  # server/edge only
STRIPE_WEBHOOK_SECRET=              # edge only

# Attio
ATTIO_API_KEY=                      # edge only

# Google Places
GOOGLE_PLACES_API_KEY=              # edge only

# SMS Provider
SMS_API_KEY=                        # edge only

# DM-Ops sync (nightly aggregate)
DM_OPS_SUPABASE_URL=                # edge only
DM_OPS_SUPABASE_SERVICE_ROLE_KEY=   # edge only
```

---

## 17. Migration Strategy (Prototype → v2)

### Phase 1 — Schema & data mapping

| Prototype | v2 | Transform |
|---|---|---|
| `tenant` (D&M row) | `contractor` | name, slug |
| `tenant` (council rows) | `client` | name, slug, branding fields |
| N/A | `sub_client` | Manual: create CAM, COT, MOS, FRE, PEP, SOP, SUB, VIN, VIC under WMRC client |
| `account_job_area` | `collection_area` | name, code; add `dm_job_code` from job.job_name; set `client_id`, `sub_client_id`, `contractor_id` |
| `eligible_properties` | `eligible_properties` | swap `account_job_area_id` → `collection_area_id` |
| `collection_date` | `collection_date` | swap `account_job_area` → `collection_area_id` |
| `allocation_rules` | `allocation_rules` | swap `account_job_area_id` → `collection_area_id` |
| `service_rules` | `service_rules` | swap `account_job_area_id` → `collection_area_id` |
| `booking` | `booking` | swap `account_job_area_id` → `collection_area_id`; add `client_id`, `contractor_id`; remove `tenant_id` |
| `booking_enquiry` | `service_ticket` | rename table + `tenant_id` → `client_id` |
| `enquiry_response` | `ticket_response` | rename table |
| `user_roles` | `user_roles` | `tenant_id` → `client_id` or `contractor_id` based on role |
| `app_role` enum | `app_role` enum | Remove `dm-admin`, `dm-staff`, `dm-field`, `admin`, `staff`; add `contractor-admin`, `contractor-staff`, `client-admin`, `client-staff` |

### Phase 2 — Data migration steps

1. Export from prototype: all booking-domain tables (see mapping above)
2. Create new Supabase project (ap-southeast-2)
3. Run v2 migrations (schema, enums, triggers, RLS)
4. Seed `contractor`, `client`, `sub_client`, `collection_area` records manually — verify codes match prototype AJA codes
5. Transform and import remaining tables in FK dependency order
6. Validate: row counts match, FK integrity passes, RLS smoke tests per role
7. Run pricing engine against 50 historical bookings — verify charges match prototype

### Phase 3 — Cutover

1. Put prototype in read-only mode (set RLS to SELECT only for all resident writes)
2. Run final delta sync for bookings created during migration window
3. DNS cutover per client subdomain (Coolify reverse proxy config)
4. Monitor error rates 48 hours — rollback plan is DNS revert to prototype

### Phase 4 — Decommission

1. Archive prototype Supabase project — retain 90 days minimum
2. Remove DM-Ops tables from prototype once confirmed fully migrated to DM-Ops project
3. Update DM-Ops Supabase client config to point at v2 project URL

---

*End of TECH_SPEC v1.0. Next artefact: `CLAUDE.md` (coding conventions and implementation instructions for Claude Code).*
