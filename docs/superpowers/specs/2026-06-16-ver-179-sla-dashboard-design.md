# Design Spec — VER-179: SLA Dashboard for the Admin Reports Screen

**Repo:** `/Users/danieltaylor/GitHub/verco` · **Branch:** `feature/ver-179-sla-dashboard` (off `develop`) · **Stack:** Next.js 16 (App Router) + Supabase (ap-southeast-2)
**Target screen:** `src/app/(admin)/admin/reports/` (`page.tsx` server shell → `reports-client.tsx` client component)
**Verification:** Every load-bearing claim was checked against the live repo + prod schema (12-agent parallel verification, 2026-06-16). Unverified items + open decisions are flagged in §8.

> **Correction note vs the raw synthesis:** an earlier draft conflated **SR (Service Tickets)** with **RS (Resident Satisfaction)**. They are distinct: **SR** = service-ticket response + resolution SLA (a scorecard card); **RS** = resident-satisfaction survey (an insight card). This spec keeps them separate.

---

## 1. Summary & Goal

A **live SLA dashboard** on the admin Reports screen that:

1. **Proves WMRC contractual compliance** — the contracted KPIs surface as scorecard cards an admin (and ultimately a council) reads at a glance: clean collection ≥98%, on-time ≥98%, rectification-within-2-working-days ≥90%, service-request close-out <30 days, resident satisfaction ≥75%.
2. **Gives D&M customer-first leverage** — internal ops KPIs (recovery rate, self-service rate, notification reliability) + three insight cards (volume & mix, property penetration, resident satisfaction) turn the same data into a story Verco can tell councils in QBRs and future tenders.
3. **Ships ahead of the 30/06/2026 go-live** — built + merged on `develop`, released to `main` before live ops data exists.

**The dominant design constraint: prod is pre-go-live sparse** — ~32 bookings, 1 NCN + 1 NP total, 0 completed collection stops, 0 submitted surveys, 4 service tickets (0 with a first-response timestamp, 2 resolved), 29/86 notifications carrying a delivery status. A naive percentage off `n=1` reads as catastrophic or perfect and would mislead a council in a demo. **Empty / low-`n` handling is therefore a first-class, mandatory feature of every card.** Cards never colour a pass/fail percentage until a per-card minimum sample size is met; below it they show the honest raw fraction + a "Building data" label. Per the standing-context convention (CLAUDE.md), below-target on the sparse pre-go-live dataset uses **info-blue / amber, never error-red**.

---

## 2. Scope

### In scope — 10 cards

**7 SLA scorecard cards** (target / pass-fail concept):

| Key | Card | Computable now? | Target | Source |
|---|---|---|---|---|
| BC | Clean Collection Rate | ✅ | ≥98% (WMRC contract) | booking + NCN |
| ONTIME | On-Time Collection | ✅ | ≥98% (WMRC contract) | collection_stop |
| RECT | Rectification within 2 working days | ✅ (new RPC) | ≥90% (WMRC contract) | NCN + NP + audit_log + public_holiday |
| **SR** | **Service Ticket SLA** (response + resolution) | ⚠️ resolution ✅ now; first-response needs FRSTAMP | first response ≤3 working days (internal) · resolution <30 days (WMRC contract) | service_ticket |
| RECOVERY | Recovery Rate | ✅ | ~95% (internal) | NCN + NP + booking |
| SELFSVC | Self-Service Rate | ⚠️ needs CBSTAMP plumbing | ≥80% (internal; soft until n meaningful) | booking.created_via (new) |
| NOTIF | Notification Reliability | ✅ (email only) | ~98% (internal) | notification_log |

**3 insight cards** (no pass/fail — directional only):

| Key | Card | Computable now? | Source |
|---|---|---|---|
| VOLMIX | Volume & Mix | ✅ | booking_item + service |
| PENETRATION | Property Penetration | ✅ (new RPC) | booking + eligible_properties + collection_area |
| **RS** | **Resident Satisfaction** | ⚠️ needs a staff SELECT RLS policy; 0 data today | booking_survey |

### Out of scope (deferred follow-ups — do not build)

- **NCN damage / non-damage split** — `ncn_reason` has 13 values, no damage flag. RECT/RECOVERY start as "all rectifications"; BC uses the `contractor_fault` filter only. Damage-vs-service rectification split is a follow-up.
- **SMS delivery rate** — no Twilio status-callback EF; `notification_log.delivery_status` is permanently NULL for `channel='sms'`. NOTIF is **email-only**; SMS shows "tracking not wired".
- **`sla_config` table wiring** — exists (per-client/per-priority) but zero consumers + zero seed rows. Do **not** wire it; hardcode VER-179 constants.
- **Strata self-service portal logic** — SELFSVC leaves a `created_via='resident'` bucket strata joins later; no strata-specific code now.

---

## 3. Per-Metric Specifications

> **Shared conventions (defined once, applied everywhere):**
> - Calc lives in a **pure function** under `src/lib/reports/<metric>.ts` (no Supabase imports), unit-tested to 100% per CLAUDE.md §14.
> - **Card chrome** matches existing summary cards (verified `reports-client.tsx:119-136`): `rounded-xl bg-white p-5 shadow-sm`, `text-[11px] font-semibold uppercase tracking-wide text-gray-400` label, `font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]` numeral.
> - **Denominator always shown** beside any % ("96.9% · 31 / 32") — sample size is never hidden.
> - Below-target colour = **amber / info-blue, never error-red** pre-go-live.
> - Three render states per card: **Empty** (denom 0) · **Low-`n`** (`0 < denom < LOW_N`: raw fraction + "Building data", no % headline, no colour) · **At-`n`** (`denom ≥ LOW_N`: % + reference line + colour).

### 3.1 BC — Clean Collection Rate ✅ now

**Definition:** `(eligible − ncn) / eligible × 100`, FY- and (optionally) area-scoped.
**Denominator (eligible — reached the field):** `COUNT(DISTINCT booking.id)` WHERE `client_id=:clientId AND deleted_at IS NULL AND fy_id=:currentFyId AND status IN ('Completed','Non-conformance','Nothing Presented','Scheduled','Missed Collection')` [+ `collection_area_id=:areaId`]. Excludes Pending Payment/Submitted/Confirmed (not yet at collection day), Cancelled (never serviced), and **'Rebooked'** (see §8 #2 — avoids one bad set-out diluting as 1 NCN / 2 bookings).
**Numerator (§8 #1 — resolved):** `COUNT(DISTINCT non_conformance_notice.booking_id WHERE contractor_fault=true)` **intersected with the eligible set** (an NCN can point at a booking outside the FY/area filter — never trust a raw NCN count). BC measures **D&M's service delivery**, so a "miss" = a collection D&M failed to complete correctly (`contractor_fault=true`); resident non-compliance (`contractor_fault=false`, e.g. resident set out building waste) does NOT count against D&M's clean-collection SLA. [Dan, 2026-06-16.] This is the service-delivery framing; the literal WMRC BC wording ("set out correctly") is partly a resident action — a strict-contract variant would be a one-line filter swap.
**Sources:** `booking.{id,status,client_id,collection_area_id,fy_id,deleted_at}`; `non_conformance_notice.{booking_id,client_id,contractor_fault}`; `financial_year.is_current`. NCN has no area/FY → scope via the `booking!inner` embed.
**Query:** client PostgREST. Eligible derived from the existing bookings fetch (extend its `.select`). NCN: `from('non_conformance_notice').select('booking_id, contractor_fault, booking!inner(collection_area_id, fy_id, client_id, deleted_at)').eq('client_id', clientId).eq('contractor_fault', true)` [+ booking-embed area/FY filters].
**Empty/low-n:** `LOW_N = 20`. `eligible=0` → "No collections yet". `<20` → raw "(elig−ncn) of elig clean" + "Building data". `≥20` → % vs 98%.
**Gotchas:** `booking` has **no `collection_date`** column → use `fy_id`. Do not reuse the existing bare client-wide `ncnCount` (unfiltered for FY/area/fault).

### 3.2 ONTIME — On-Time Collection ✅ now

**Definition:** `(completed stops where completed-AWST-date == scheduled-date) / (all completed stops) × 100`.
**Source (authoritative):** `collection_stop.completed_at` (UTC timestamptz, set at crew closeout + by the `sync_stops_on_booking_status` trigger) + `collection_stop.collection_date_id → collection_date.date` (AWST) + `collection_stop.client_id`. **`booking` has no `completed_at`** — do NOT use `audit_log`.
**Denominator:** `collection_stop` `status='Completed' AND completed_at IS NOT NULL`, scoped by `client_id` [+ area].
**CRITICAL TZ:** `completed_at` is UTC, `collection_date.date` is AWST. Compare `awstDateFromUtc(new Date(completed_at)) === stop.collection_date.date`. **Never** `completed_at::date` in UTC (a 7:30am-AWST closeout is the previous UTC day → mis-bucket). Reuse `awstDateFromUtc` from `src/lib/booking/schedule-transition.ts` (UTC+8, no DST — verified).
**Query:** client PostgREST: `from('collection_stop').select('completed_at, collection_date:collection_date_id!inner(date, collection_area_id)').eq('status','Completed').not('completed_at','is',null).eq('client_id', clientId)` [+ `.eq('collection_date.collection_area_id', areaId)`].
**Pure fn `on-time.ts`:** `isOnTime(stop)`, `computeOnTime(stops) → {completed, onTime, pct}` (pct null when completed=0). `TARGET=98`, `LOW_N=20`.
**Gotchas:** TZ (highest risk). Per-stop vs per-booking denominator (§8 #3) — a multi-stream booking contributes up to 2 stop rows.

### 3.3 RECT — Rectification within 2 Working Days ✅ now (new RPC)

**Definition:** ≥90% of NCN/NP rectifications completed within 2 **working** days of issue.
**Denominator:** NCN+NP where `rescheduled_booking_id IS NOT NULL` AND the rebooked booking reached `status='Completed'`, scoped by `notice.client_id` [+ rebooked booking's area]. In-flight rectifications (Submitted/Confirmed/Scheduled) are excluded from **both** num and denom (pending, not failure).
**Numerator:** qualifying rows where `workingDaysBetween(reported_at_AWST, completedAt_AWST) ≤ 2`. `workingDaysBetween` = weekdays strictly after start through end, minus `public_holiday.date` (jurisdiction='WA') in `[start+1 .. end]`.
**Completion timestamp:** `booking` has no `completed_at` → `end = MIN(audit_log.created_at)` WHERE `table_name='booking' AND record_id=rescheduled_booking_id AND new_data->>'status'='Completed'`, cast AWST.
**Query:** **NEW SECURITY DEFINER RPC `get_rect_sla(p_client_id uuid, p_area_id uuid) → {numerator, denominator, pct}`** — justified: completion time lives in `audit_log` jsonb keyed by record_id+status, unioned across NCN+NP, joined to `public_holiday`, with working-day arithmetic; impractical as client round-trips. **Mirror the working-days + ≤2 logic in pure fn `rect.ts`** (Vitest 100%) so the date math is DB-independent.
**Empty/low-n:** `LOW_N=5`. `<5` completed rectifications → raw count only.
**Gotchas:** bookings completed before the audit trigger (migration `20260416100000`, 2026-04-16) have no audit row → exclude/flag. Notice status `Rescheduled`/`Rebooked` = a rebook was *raised*, not collected — gate on the rebooked booking being `Completed`.

### 3.4 SR — Service Ticket SLA ⚠️ resolution now; first-response needs FRSTAMP

**Definition (two sub-SLAs on one card):**
- **First response** within **3 working days**: `created_at → first_response_at`. Internal service standard (Dan, 2026-06-16). `first_response_at` is **NULL on all 4 tickets today** — populated going forward by **FRSTAMP** (§4.1).
- **Resolution** within **30 days**: `created_at → COALESCE(resolved_at, closed_at)`. Maps to the WMRC contract SR KPI ("close out agreed system requests < 30 days") — in Verco v2 those system requests ARE `service_ticket` rows, so this is computed in-app (no Linear dependency).

Present each sub-SLA as **% within target** (+ the denominator); optionally a median alongside.
**Sources:** `service_ticket.{created_at, first_response_at, resolved_at, closed_at, status, category, priority, client_id, booking_id}`. No `collection_area_id` — area filter is transitive via `booking` and only applies to booking-linked tickets.
**Query:** client PostgREST: `from('service_ticket').select('created_at, first_response_at, resolved_at, closed_at, status, booking:booking_id(collection_area_id)').eq('client_id', clientId)`. Fold in JS.
**Pure fn `service-ticket-sla.ts`:** `computeServiceTicketSla(tickets) → { responded: {n, withinTarget, pct}, resolved: {n, withinTarget, pct} }`. Reuse the `workingDaysBetween` helper (shared with RECT) for the 3-working-day response window; resolution window in calendar days (§8 #12). `RESPONSE_TARGET_WD=3`, `RESOLUTION_TARGET_DAYS=30`, `LOW_N=5`.
**Empty/low-n:** first-response sub-metric → "Tracking starts <FRSTAMP release date>" until `first_response_at` populates; resolution sub-metric → "2 of 4 resolved" raw until `LOW_N`. `<5` resolved/responded → raw fractions, no %.
**Area filter:** via `booking!inner(collection_area_id)` when an area is selected (drops booking-less tickets); "All Areas" includes every ticket. Note booking-less tickets (general enquiries) can't be area-attributed — flag (§8 #13).
**Gotchas:** first-response sub-metric is **inert until FRSTAMP ships to prod**. Resolution end = `COALESCE(resolved_at, closed_at)` (a ticket can be closed without an explicit resolved_at). `status` (open/resolved/closed) is the lifecycle; resolution timestamp is the SLA basis.

### 3.5 RECOVERY — Recovery Rate ✅ now

**Definition:** % of NCN/NP **ever** rebooked AND completed. Internal ~95%. No time bound (distinct from RECT).
**Denominator (recoverable):** **all** NCN+NP rows in scope (a still-Issued/Disputed notice never rebooked is a recovery *failure*, so it belongs in the denominator). **Numerator (recovered):** `rescheduled_booking_id IS NOT NULL AND rebookedBookingStatus='Completed'`.
**Query (split-query + stitch — MANDATORY):** NCN and NP each have **two FKs to `booking`** (`booking_id` + `rescheduled_booking_id`) → the documented multi-FK embed trap (silent empty inner under RLS). So: Q1 NCN `select('id, rescheduled_booking_id, booking:booking!non_conformance_notice_booking_id_fkey(collection_area_id)')`; Q2 same for NP with `!nothing_presented_booking_id_fkey`; Q3 `from('booking').select('id, status').in('id', rescheduledIds)` → `Map`; then fold. **Never embed the rebooked booking.**
**Pure fn `src/lib/ncn/recovery-rate.ts`:** `recoveryRate(notices, rebookedStatusById) → {recoverable, recovered, rate}`. `LOW_N=5`.
**Area filter:** on the **original** notice's `booking.collection_area_id` (client-side after fetch).
**Gotchas:** multi-FK embed trap (highest risk) — explicit `!fk_name` always. Refund-resolved notices have `Resolved` status with NO `rescheduled_booking_id` (§8 #4) → default = non-recovery.

### 3.6 SELFSVC — Self-Service Rate ⚠️ needs CBSTAMP plumbing

**Definition:** % of in-scope bookings created by a resident. Internal; suggested ≥80% but soft until n is meaningful.
**Denominator:** `booking` `type IN ('Residential','MUD') AND status<>'Cancelled'`. **Numerator:** same set where `created_via='resident'`.
**Source (after CBSTAMP):** new `booking.created_via` ('resident'|'admin'|'ranger'|'system'). **Rejected:** `created_by → user_roles.role` join (RLS hides resident roles from admins; roles mutate). An immutable `created_via` stamped at INSERT is the only correct signal.
**Query:** client PostgREST — extend the existing bookings fetch to include `created_via`.
**Pure fn `self-service.ts`:** `classifyBookingChannel(row)` + `computeSelfServiceRate(rows, {nMin})`, `N_MIN=20`.
**Empty/low-n:** before CBSTAMP / `created_via` NULL → "Self-service tracking starts <date>" + raw in-scope count, no %. Compute the rate ONLY over stamped rows; footnote "{x} earlier bookings excluded (channel not recorded)" — never blend NULL legacy rows into the denominator.
**Gotchas:** hard dependency on CBSTAMP. The `on_behalf=true` URL param is **client-controlled — do not trust it** as the classifier; derive `created_via` server-side from the acting user's role in the EF.

### 3.7 NOTIF — Notification Reliability ✅ now (EMAIL ONLY)

**Definition:** `delivered% = positive / (positive + negative) × 100` over **email** rows. Internal ~98%.
**Source:** `notification_log.{channel, delivery_status, client_id}`. `delivery_status` is a ranked lifecycle that never downgrades. **positive** = `delivery_status IN ('delivered','opened')` (opened supersedes delivered — MUST be counted as success). **negative** = `IN ('bounced','dropped','spam')`. **excluded** = `'deferred'` (transient) + NULL (untracked).
**Query:** `from('notification_log').select('delivery_status').eq('client_id', clientId).eq('channel','email').not('delivery_status','is',null)`, fold in JS.
**Pure fn `notification-reliability.ts`:** fold → `{positive, negative, tracked, pct}`. `LOW_N=10`.
**Area filter:** **does NOT apply** — `notification_log` has no area + many rows (OTP/auth) have no booking. Card ignores the area selector + shows an "all notifications" note.
**Gotchas:** email-only (SMS delivery_status permanently NULL). Counting only `=='delivered'` undercounts (opened wins). `status` (sent/failed) ≠ delivery. Webhook fails closed without `SENDGRID_WEBHOOK_VERIFICATION_KEY`.

### 3.8 VOLMIX — Volume & Mix (insight) ✅ now

**Definition:** total collections + breakdown by waste stream + by service. No pass/fail.
**Quantity:** `volume_unit = COALESCE(actual_services, no_services)` (mirrors `nightly-sync-to-dm-ops`). `actual_services` NULL today → label "Collections (booked)" until actuals exist. **Bookings counted:** all `status NOT IN ('Cancelled','Pending Payment')` (do NOT restrict to Completed — 0 today would zero the card).
**Aggregation:** `total = Σ volume_unit`; `by_stream` on `service.waste_stream`; `by_service` on `service.id` (label `service.name`), desc.
**Query:** `from('booking').select('status, collection_area_id, booking_item(no_services, actual_services, is_extra, service!inner(name, waste_stream))').eq('client_id', clientId).not('status','in','("Cancelled","Pending Payment")')` [+ area]. **Double-quote `"Pending Payment"`** (space) — unquoted comma → PGRST100 silent `data:null`.
**Pure fn `volume-mix.ts`:** flat rows → `{totalCollections, byStream, byService[], freeUnits, extraUnits}`. `LOW_N=20`. Share bars only at `≥20`; reuse `Math.max(2, share*100)` bar-width guard.
**Gotchas:** always COALESCE; `.not('status','in',...)` value quoting; `service!inner` is single-FK (safe).

### 3.9 PENETRATION — Property Penetration (insight) ✅ now (new RPC)

**Definition:** `100 × distinct booked eligible properties / total eligible properties`, by client [+ area]. No target — directional.
**Numerator:** `COUNT(DISTINCT booking.property_id)` WHERE `client_id=:clientId AND property_id IS NOT NULL AND deleted_at IS NULL AND status<>'Cancelled'` [+ area]. **Denominator:** `COUNT(*)` over `eligible_properties ep JOIN collection_area ca ON ca.id=ep.collection_area_id` WHERE `ca.client_id=:clientId` [+ `ep.collection_area_id=:areaId`].
**Query:** **NEW RPC `get_property_penetration(p_client_id uuid, p_area_id uuid DEFAULT NULL) RETURNS TABLE(booked bigint, eligible bigint)`, LANGUAGE sql STABLE SECURITY INVOKER, GRANT EXECUTE TO authenticated.** Two hard reasons it can't be client-side: PostgREST can't `COUNT(DISTINCT)`; the ~107k-row denominator can't be client-fetched + must filter through `collection_area.client_id` (`eligible_properties` has **no `client_id`** + public-SELECT RLS).
**Pure fn `penetration.ts`:** `computePenetration({booked, eligible, lowNThreshold}) → {pct, display, isLowN, isEmpty}`. `LOW_N=25`.
**Empty/low-n:** `eligible=0` → "No eligible properties imported". `booked<25` (normal today, ~0.015%) → raw fraction "16 / 107,281", suppress % headline. Never pass/fail-coloured.
**Gotchas:** `eligible_properties` has **NO `client_id`** — scope via the `collection_area` join only. ID bookings have `property_id=NULL` (correctly excluded). Known duplicate imports (PR #182/#183) inflate the denominator — flag.

### 3.10 RS — Resident Satisfaction (insight) ⚠️ needs a staff SELECT RLS policy; 0 data today

**Definition:** `(surveys with overall_rating ≥4) / (submitted surveys with a valid 1-5 overall_rating) × 100`. Target ≥75% (WMRC RS KPI) — rendered as an insight reference, not pass/fail, given it's brand-new + empty.
**Sources:** `booking_survey.{responses(jsonb), submitted_at, client_id, booking_id}`. Rating = `Number(responses.overall_rating)` (the survey form writes `overall_rating` 1-5). No area column → transitive via `booking`.
**HARD BLOCKER (plumbing):** `booking_survey` RLS has only a resident SELECT + field INSERT policy — **no staff/admin/contractor SELECT**. A client-admin via anon key gets zero rows. A **new staff SELECT policy migration must ship to `main` before this card can ever return data** (§4.3).
**Query:** client PostgREST. `from('booking_survey').select('responses, booking!inner(collection_area_id)').not('submitted_at','is',null).eq('client_id', clientId)` [+ area when selected; drop the embed for "All Areas" to avoid multi-FK fragility]. Extract `Number(responses.overall_rating)` in JS — never `responses->>'overall_rating'` + PostgREST `.gte` (jsonb text compare is lexical: `'10' < '4'`).
**Pure fn `resident-satisfaction.ts`:** `computeResidentSatisfaction(rows) → {n, good, pct}` (pct null when n=0; skip NaN/null/out-of-1..5; good = `r≥4`). `LOW_N=5`.
**Empty/low-n:** `n=0` (reality today) → "No responses yet". `<5` → "{good} of {n} rated good" + "Building data", no %. `≥5` → % + "{n} responses".
**Gotchas:** exclude `submitted_at IS NULL` shells. RS is specifically `overall_rating` — do not average the three sub-ratings. Sub-client scoping (§8 #5): `booking_survey` is not in the 17 sub-client-scoped policies; if a COT-narrowed client-admin must not see MOS surveys, route the new policy through `user_sub_client_allows_booking(booking_id)`.

---

## 4. Plumbing Changes (3 migrations)

All ship **PR-A (migration → release to `main` first) → PR-B (consumer + types regen)** per the Types-Freshness CI split (CLAUDE.md §21) — migrations apply on `branches:[main]` only, so a consumer card returns nothing until its PR-A is on prod.

### 4.1 FRSTAMP — stamp `service_ticket.first_response_at` (for SR's first-response sub-metric)

`first_response_at` is never set today. AFTER INSERT trigger on `ticket_response` (the staff-reply table):
```sql
CREATE OR REPLACE FUNCTION stamp_first_response()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.author_type = 'staff' AND NEW.is_internal = false THEN
    UPDATE service_ticket SET first_response_at = NEW.created_at
     WHERE id = NEW.ticket_id AND first_response_at IS NULL;  -- idempotent
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER ticket_response_stamp_first_response
  AFTER INSERT ON ticket_response FOR EACH ROW EXECUTE FUNCTION stamp_first_response();
```
"First response" = first **non-internal staff** reply. `first_response_at` column already exists → **no types regen**, one PR. Optional same-migration backfill for the 4 historical tickets (`MIN(created_at)` of staff non-internal replies). Do NOT stamp on resident replies.
**Verify during implementation:** the exact reply-table name + its `author_type`/`is_internal`/`ticket_id` columns (the trigger shape above is from the SR/FRSTAMP fragment — confirm against the migration before writing).
**Files:** `supabase/migrations/<ts>_stamp_first_response_at.sql`.

### 4.2 CBSTAMP — stamp `booking.created_via` + admin/resident classification (for SELFSVC)

**PR-A migration:**
- `ALTER TABLE booking ADD COLUMN created_via text NOT NULL DEFAULT 'system'`. Backfill the existing 32 rows to `'legacy'` so the report honestly excludes them.
- DROP both overloads of `create_booking_with_capacity_check` (13-arg `p_actor_id` + 14-arg `p_type`), CREATE OR REPLACE with trailing `p_created_via text DEFAULT 'system'`, add `created_via` to the INSERT.
- Re-state `create_id_booking_with_capacity_check` to write `created_via='ranger'` (already stamps `created_by=auth.uid()`).

**PR-B (consumer + types regen):**
- `create-booking` EF: after the acting user resolves, look up role via `user_roles` (staff = `role IN ('contractor-admin','contractor-staff','client-admin','client-staff')` — **not** `is_contractor_user()`, which includes `field`); compute `created_via` = `'resident'` (guest/no-session/email-match) vs `'admin'` (staff + email-mismatch); pass to the RPC.
- MUD admin-on-behalf action (`admin/properties/[id]/book/actions.ts`): pass `created_via='admin'`.
- New pure fn `src/lib/bookings/classify-creator.ts` (unit-tested); regen `types.ts`; add `created_via` to `src/lib/audit/field-labels.ts`.

**CRITICAL gotcha:** `auth.uid()` is NULL inside `create_booking_with_capacity_check` (EF calls it with the **service-role** client — hence the existing `p_actor_id`). Classification MUST happen in the EF (TypeScript, live user JWT), passed as an explicit param — not via `current_user_role()` in the RPC. (Contrast: the ID RPC runs under the ranger's JWT, so `auth.uid()` works there.) Standardise on `created_via` (single classifier; drop the alternate `is_admin_created` boolean — §8 #8).

### 4.3 RS-RLS — staff SELECT policy on `booking_survey` (for RS)

`booking_survey` has no staff/admin/contractor SELECT policy → RS returns 0 rows forever without it. Add a SELECT policy for staff roles (mirror the `current_user_role() IN ('contractor-admin','contractor-staff','client-admin','client-staff')` pattern; route through `user_sub_client_allows_booking(booking_id)` if §8 #5 says sub-client narrowing is required). Policy-only → no types change. Must reach `main` before RS shows data.
**Files:** `supabase/migrations/<ts>_booking_survey_staff_select.sql`.

---

## 5. Architecture

### 5.1 Pure-function calc layer (`src/lib/reports/`)
One pure file per metric (no Supabase imports → 100% unit-testable per CLAUDE.md §14); the card is a thin renderer. Each exports its `LOW_N`/target constants (testable + tunable):
```
clean-collection.ts (BC)            on-time.ts (ONTIME)         rect.ts (RECT, working-days)
service-ticket-sla.ts (SR)          notification-reliability.ts (NOTIF)
self-service.ts (SELFSVC)           volume-mix.ts (VOLMIX)      penetration.ts (PENETRATION)
resident-satisfaction.ts (RS)       src/lib/ncn/recovery-rate.ts (RECOVERY, co-located w/ ncn helpers)
src/lib/bookings/classify-creator.ts (CBSTAMP classification)
```
A shared **working-days helper** (`workingDaysBetween` + WA-holiday aware) is used by RECT and SR — extract once, test once.

### 5.2 Query strategy — ONE coherent rule: **client PostgREST by default; RPC only where PostgREST physically can't**

| Metric | Approach | Why |
|---|---|---|
| BC, ONTIME, SR, RECOVERY, NOTIF, VOLMIX, SELFSVC, RS | **Client PostgREST** | tiny data, RLS-scoped, pure-fn fold; matches existing cards |
| **RECT** | **RPC `get_rect_sla`** | completion time in `audit_log` jsonb + NCN/NP union + holiday join + working-day math |
| **PENETRATION** | **RPC `get_property_penetration`** | PostgREST can't `COUNT(DISTINCT)`; ~107k-row denominator; must join through `collection_area` for tenant scope |

Deliberately **not** a single "one big reports RPC" (would force every card through the migration→release→consumer split for no benefit). If VER-179 later grows many server-aggregated cards, fold both RPC bodies into one then — both are RPC-ready.

### 5.3 Current-FY plumbing (BC)
`getCurrentAdminClient()` returns no FY (`{id, slug, name, contractorId}` — verified). `financial_year.is_current` is public-readable + in types. **Resolve `currentFyId` in `page.tsx`** alongside `getCurrentAdminClient()` and pass as a prop (matches the server-shell pattern; one fewer round-trip). Add to BC's queryKey.

### 5.4 Empty / low-`n` thresholds
BC/ONTIME/VOLMIX/SELFSVC = 20 · RECT/RECOVERY/SR/RS = 5 · NOTIF = 10 · PENETRATION = 25. (Per-card; see §8 #10.)

### 5.5 Area filter
Reuse the existing `selectedArea` state + area `<select>` (already client-scoped by `client_id`). Each card's query adds `selectedArea` to its queryKey. Direct `.eq('collection_area_id', areaId)`: BC bookings, VOLMIX, SELFSVC, PENETRATION numerator. Via `!inner` embed: ONTIME, BC-NCN, SR (booking-linked tickets only), RECOVERY, RECT (RPC param), PENETRATION denom (RPC param). **No area filter:** NOTIF.

### 5.6 Card UI & colour
Match the existing summary-card markup exactly. Numerals navy `#293F52`. Pass/fail colour only above `LOW_N`: green at/above target; **amber / info-blue below** (never error-red pre-go-live). Insight cards (VOLMIX, PENETRATION, RS) never colour pass/fail. Leave existing cards untouched unless BC supersedes the bare `ncnCount` card (surgical-change rule).

---

## 6. Testing Plan (TDD — test-first, 100% on pure fns)

| Pure fn | Critical cases |
|---|---|
| `clean-collection` | 0 eligible→empty; `<20`→low-n; ≥98%→green; <98%→below-target; NCN outside eligible set intersected out; numerator basis (a) vs (b) |
| `on-time` | same date (on-time); 1 day late; **23:30-UTC-prev-day boundary (AWST proof)**; empty; all-on-time; low-n at 20 |
| `rect` | **working-days across weekend + WA-holiday**; AWST cast at midnight; in-flight excluded both sides; ≤2 pass / >2 fail; n<5 |
| `service-ticket-sla` | response within/over 3 working days; first_response_at NULL → response sub-metric "tracking starts"; resolution within/over 30 days; `COALESCE(resolved_at, closed_at)`; n<5; booking-less ticket area handling |
| `recovery-rate` | zero notices; n<5; rescheduled-but-Submitted (not recovered); rescheduled-and-Completed; rescheduled-and-Cancelled; null rescheduled; mixed NCN+NP; refund-resolved |
| `notification-reliability` | delivered+opened both positive; deferred/null excluded; bounce on 3 rows stays low-n; tracked<10 |
| `self-service` | resident/admin/ranger/system; low-n; NULL-legacy exclusion; `classify-creator` guest/authed/staff-on-behalf/email-collision |
| `volume-mix` | empty; single + multi stream; actual_services vs no_services fallback; extra split; low-n at 20 |
| `penetration` | empty eligible; low-n raw fraction; normal %; cancelled-exclusion; div-by-zero |
| `resident-satisfaction` | empty; n<5; n≥5; all-good; mixed; null/invalid/out-of-range/non-integer rating |
| shared `workingDaysBetween` | weekend + holiday + midnight edges (used by RECT + SR) |

**Smoke / integration:** RLS smoke (`booking_survey` staff SELECT returns rows for admin, zero for wrong-client); RPC smoke (`get_rect_sla`, `get_property_penetration` under a tenant JWT on a seeded fixture); card render (empty/low-n/at-n from canned pure-fn outputs, Testing Library). Read-only cards need no new E2E; existing booking-flow E2E unaffected.

---

## 7. File Plan

**New — pure fns + tests:** `src/lib/reports/{clean-collection,on-time,rect,service-ticket-sla,notification-reliability,self-service,volume-mix,penetration,resident-satisfaction}.ts` · `src/lib/ncn/recovery-rate.ts` · `src/lib/bookings/classify-creator.ts` · shared `src/lib/reports/working-days.ts` — each with a `src/__tests__/...` companion.
**New — migrations:** `get_rect_sla_rpc.sql` · `get_property_penetration_rpc.sql` · `booking_survey_staff_select.sql` (RS, PR-A) · `stamp_first_response_at.sql` (FRSTAMP) · `booking_created_via.sql` (CBSTAMP PR-A: column + backfill + RPC re-statement).
**Modify:** `reports-client.tsx` (all card queries + render 10 cards; extend the bookings fetch to `.select('id, status, fy_id, type, created_via')`; add collection_stop / NCN-embed / service_ticket / booking_survey / notification_log / recovery split-queries + the two `supabase.rpc(...)` calls) · `reports/page.tsx` (resolve `currentFyId`, pass prop) · `supabase/functions/create-booking/index.ts` (CBSTAMP PR-B) · `admin/properties/[id]/book/actions.ts` (CBSTAMP PR-B) · `src/lib/supabase/types.ts` (regen after each PR-A reaches prod) · `src/lib/audit/field-labels.ts` (CBSTAMP `created_via` label).

**Release sequencing:** PR-A migrations (rect RPC, penetration RPC, booking_survey staff SELECT, FRSTAMP, created_via column) → release to `main` → regen types → PR-B (the reports-client consumer + create-booking EF). The "now-computable" cards (BC, ONTIME, RECOVERY, NOTIF, VOLMIX) can ship in the first consumer PR; SR-first-response, SELFSVC, RS light up after their PR-A lands on prod.

---

## 8. Open Decisions (for Dan / VER-179 lead)

| # | Decision | Default this spec takes |
|---|---|---|
| 1 | **BC numerator** — which NCNs count as a "miss"? | ✅ **Resolved: contractor-fault only** (`contractor_fault=true`) — BC measures D&M's service delivery, not resident compliance. [Dan, 2026-06-16] |
| 2 | **BC denominator: exclude `'Rebooked'`?** | Exclude Rebooked, keep Non-conformance |
| 3 | **ONTIME grain:** per-collection-pass (per-stop) vs per-booking? | Per-stop |
| 4 | **RECOVERY:** does a refund-resolved notice (no rebook) count? | Count as non-recovery |
| 5 | **RS sub-client scoping:** block a COT-narrowed admin from MOS surveys for v1? | Whole-client (`accessible_client_ids()`) unless told otherwise |
| 6 | **PENETRATION:** count Cancelled bookings? | Exclude |
| 7 | **Per-tenant targets:** Kwinana has no contractual 98%. | 98%/etc. as a soft reference line for non-WMRC tenants, not hard pass/fail |
| 8 | **CBSTAMP shape:** `created_via` text/enum (this spec) vs `is_admin_created` boolean. | `created_via` single classifier |
| 10 | **Low-`n` thresholds:** per-card (20/5/10/25) vs one shared constant? | Per-card |
| 12 | **SR units:** first response in working vs calendar days? resolution 30 working vs calendar? | First response ≤3 **working** days (reuse RECT helper); resolution <30 **calendar** days |
| 13 | **SR area filter:** booking-less tickets (general enquiries) can't be area-attributed. | Area filter includes only booking-linked tickets; "All Areas" includes all |

**Unverified items carried forward (confirm at implementation):** `ticket_response` table name + `author_type`/`is_internal`/`ticket_id` columns for FRSTAMP; `booking_survey.responses.overall_rating` key shape (extract defensively); ONTIME `collection_stop.completed_at` is the resolved authoritative source (audit_log is the rejected fallback).

**Verification log (re-checked live):** `reports-client.tsx` structure + card markup (119-136); `awstDateFromUtc` UTC+8 no-DST; `booking` Row has `created_by`/`fy_id`, **no `completed_at`/`collection_date`/`created_via`**; `financial_year.is_current` public-readable; `getCurrentAdminClient()` returns no FY; `service_ticket` has `created_at`/`first_response_at`/`resolved_at`/`closed_at`; `booking_survey` has `submitted_at`/`responses`, no staff SELECT policy; `notification_log.delivery_status` populated 29/86; `eligible_properties` has no `client_id`.
