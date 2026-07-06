# NCN/NP — Exceptions vs Investigations model

- **Date:** 2026-07-06
- **Status:** Draft for review (no implementation yet)
- **Author:** Claude (brainstormed with Dan)
- **Related memory:** `ncn-np-record-tables-unpopulated`, `ncn-np-workflow`, `field-stops-optimoroute-architecture`

---

## 1. Problem

The sidebar Exception badges, the two Exception list tables, and the admin dashboard exception surfaces read from **different sources**, so they disagree.

| Surface | Current source | Prod value (06/07/2026) |
|---|---|---|
| Sidebar badge — Non-Conformance | `booking.status = 'Non-conformance'` | **5** |
| Table `/admin/non-conformance` | `non_conformance_notice` records | **0** |
| Sidebar badge — Nothing Presented | `booking.status = 'Nothing Presented'` | **4** |
| Table `/admin/nothing-presented` | `nothing_presented` records | **10** |
| Dashboard "Open Exceptions" card + list | `booking.status IN (…)` counts + rows | 9 |

**Why the counts diverge:**
- The **5 NCN bookings** are `created_via = 'legacy'` Airtable imports (MOS/COT). Their *status* was imported, but the collection never ran through Verco's field closeout, so no `non_conformance_notice` record exists. This is expected, not a bug.
- The **10 NP records** were created by Verco's real stop closeout (`raiseNpForStop`), but 6 of them sit on bookings that have since moved to Rebooked/Completed — so the record table over-reports relative to current booking status.
- Field closeout **does** create notice records now (`raiseNcnForStop` / `raiseNpForStop` in `src/app/(field)/field/stops/[id]/actions.ts`). The historical gap is only for legacy-imported statuses.

## 2. The model

Introduce a clear distinction the code currently blurs:

- **Exception** — a booking whose `status` is `Non-conformance` or `Nothing Presented`. Created by Verco field closeout **or** legacy import. Every exception is a row in the tables.
- **Investigation** — a notice record (`non_conformance_notice` / `nothing_presented`) and its lifecycle: `Issued → Disputed → Under Review → Resolved / Rescheduled(NCN) / Rebooked(NP) / Closed`. An exception has **zero or one** investigation.

State groupings (from `ncn_status` / `np_status` enums; the `Open` enum value is unused legacy):

| Group | States |
|---|---|
| **Open investigation** | `Disputed`, `Under Review` |
| Raised, not yet an open investigation | `Issued` |
| Not investigated | *(no notice record — e.g. legacy import)* |
| Terminal | `Resolved`, `Rescheduled` (NCN), `Rebooked` (NP), `Closed` |

## 3. Locked decisions

1. **Badge = open investigations** — `Disputed` + `Under Review` notice records, client-scoped.
2. **Tables = all exceptions incl. resolved history** — union of every notice record + record-less exception bookings, with a Status filter **defaulting to open**. Table "open" default = everything not terminal = `{Not investigated, Issued, Disputed, Under Review}` (broader than the badge, so the 5 legacy NCNs and any Issued records still show by default).
3. **Dashboard NCN/NP surfaces = open investigations** — the dashboard exception card + list use the same `Disputed`+`Under Review` definition as the badge.
4. **Staff/admin can open an investigation on behalf of a resident** — creates a notice record (record-less case) or advances an `Issued` one straight to `Under Review`, relaxing today's "staff can't touch Issued" gate. Contractor/client admin+staff only — never field/ranger.
5. **Booking-detail cards** — admin booking detail gains an Exceptions card + Service Tickets card; resident booking detail's existing exception card is extended to render for record-less exceptions.
6. **Phased into 3 PRs to `develop`** (see §9).

### Expectation to flag on ship
After Part 1, **both Exception badges and the dashboard exception card read 0** until an investigation is opened (staff-on-behalf or resident dispute) — there are currently no `Disputed`/`Under Review` records. That is the intended "needs attention" signal. All 5 NCN + 4 NP exceptions still appear in the tables.

---

## 4. Part 1 — Badge, tables & dashboard consistency

### 4.1 Sidebar badge — `src/app/(admin)/admin/layout.tsx`
Replace the `ncnQuery` / `npQuery` booking-status counts with notice-record counts:

```
ncn: non_conformance_notice where status IN ('Disputed','Under Review') [+ client_id]
np:  nothing_presented       where status IN ('Disputed','Under Review') [+ client_id]
```

Service-ticket badge already counts `status IN ('open','in_progress')` — no change.

### 4.2 Exception tables — union views

Add one `security_invoker` view per type that unions notice records with record-less exception bookings, exposing a normalised display shape so the table needs no fragile embeds. Illustrative (final DDL in the plan):

```sql
CREATE VIEW v_ncn_exceptions WITH (security_invoker = on) AS
  SELECT n.id AS notice_id, n.booking_id, n.client_id, b.ref, ca.code AS area_code,
         coalesce(ep.formatted_address, ep.address) AS address,
         n.reason::text AS reason, n.status::text AS investigation_status,
         n.reported_at, n.reported_by, pr.display_name AS reporter_name,
         n.photos, n.notes, true AS is_investigated
  FROM non_conformance_notice n
  JOIN booking b          ON b.id = n.booking_id
  JOIN collection_area ca ON ca.id = b.collection_area_id
  LEFT JOIN eligible_properties ep ON ep.id = b.property_id
  LEFT JOIN profiles pr   ON pr.id = n.reported_by
  UNION ALL
  SELECT NULL::uuid, b.id, b.client_id, b.ref, ca.code,
         coalesce(ep.formatted_address, ep.address),
         NULL, 'Not investigated', b.updated_at, NULL::uuid, NULL,
         '{}'::text[], NULL, false
  FROM booking b
  JOIN collection_area ca ON ca.id = b.collection_area_id
  LEFT JOIN eligible_properties ep ON ep.id = b.property_id
  WHERE b.status = 'Non-conformance'
    AND NOT EXISTS (SELECT 1 FROM non_conformance_notice n WHERE n.booking_id = b.id);
```

`v_np_exceptions` is analogous (`status = 'Nothing Presented'`, no `reason`, add `contractor_fault`).

- **`security_invoker = on`** so the caller's RLS on `non_conformance_notice` / `nothing_presented` / `booking` / `profiles` applies (per CLAUDE.md §21 view gotcha — DEFINER views leak cross-tenant).
- Table clients (`non-conformance-client.tsx`, `nothing-presented-client.tsx`) switch their query from the base table to the view, keeping app-level `.eq('client_id', clientId)` (public-SELECT scoping habit) + `count: 'exact'` + range pagination.
- **Status filter** options become: All, Not investigated, Issued, Disputed, Under Review, Resolved, Rescheduled/Rebooked, Closed. Default = **open** (Not investigated + Issued + Disputed + Under Review). Implemented as `.in('investigation_status', [...])` for the default, `.eq(...)` for a specific pick.
- **Row identity & action:** row keyed by `coalesce(notice_id, booking_id)`. If `is_investigated` → "View" → `/admin/non-conformance/[notice_id]` (existing detail page). If not → **"Open investigation"** button (Part 2).
- Reason filter applies only to investigated rows (record-less rows have `reason = NULL`).

### 4.3 Dashboard — `src/app/(admin)/admin/page.tsx`
- The **"Open Exceptions" list tile** (≈ lines 553–600) and its **count card** (≈ line 352) switch from `booking.status` to the open-investigation definition (`Disputed` + `Under Review` records, per type). Consider renaming the surface **"Open Investigations"** for honesty (confirm in review).
- The **"This week"** NCN/NP tallies (`weekNcn` / `weekNp`, ≈ lines 208–215) stay keyed off `booking.status` — they measure this week's *outcomes*, not investigation state. Deliberately unchanged.

---

## 5. Part 2 — Open an investigation on behalf

### 5.1 Server action
`openInvestigation({ kind: 'ncn' | 'np', bookingId, reason? })` (co-located with the exception surfaces; mirrors the resolution-action pattern in `.../non-conformance/[id]/actions.ts` — `verifyStaffRole()`, `Result<T>` return, zod-validated input).

Behaviour:
- Resolve the booking's `client_id`; assert booking status is the matching exception status.
- **If a notice record exists** and is `Issued` → UPDATE to `Under Review`.
- **If none exists** (legacy/record-less) → INSERT a notice with `status = 'Under Review'`, `reported_by = auth.uid()`, `reason` (NCN only — NOT NULL, staff picks from `NCN_REASONS`), `collection_stop_id` linked if a stop exists else NULL (both notice tables allow NULL `collection_stop_id`).
- Idempotent-ish: if already `Under Review`/`Disputed`, no-op success; if terminal, reject.

### 5.2 RLS changes
Minimal additions (same migration, per CLAUDE.md §21 "RLS coverage lags data plumbing"):
- **INSERT:** allow contractor/client admin+staff to insert a notice for a booking in `accessible_client_ids()`, `WITH CHECK` constraining `status` to `Under Review` and `client_id` to scope. (Field INSERT policy stays for closeout.)
- **UPDATE:** extend the staff update policy so `Issued → Under Review` is permitted (today staff may act only on `Disputed`/`Under Review`).
- Keep the resident dispute policies (`ncn_resident_update_dispute` / `np_resident_update_dispute`) untouched.
- Role gate must be NULL-safe (`(current_user_role() IN (...)) IS NOT TRUE`) per CLAUDE.md §21.

### 5.3 Entry points
- Exception table row action ("Open investigation") for `Not investigated` and `Issued` rows.
- Booking-detail Exceptions card (Part 3) — same action.
- (The existing detail page already handles `Disputed`/`Under Review` resolution; opening just gets it there.)

### 5.4 Actor & notifications
- **Actor** captured by the existing `audit_trigger_fn()` on the notice tables (no new column). Add a note like "Opened on behalf by staff" to `notes`/`resolution_notes`? — see open question OQ2.
- **Resident notification on open-on-behalf:** default **no** (internal staff action; resident already received `ncn_raised`/`np_raised` at closeout for Verco exceptions; legacy imports have no Verco resident comms). See OQ1.

---

## 6. Part 3 — Booking-detail cards

### 6.1 Admin — `src/app/(admin)/admin/bookings/[id]/page.tsx` (+ client)
Currently fetches neither exceptions nor tickets. Add:
- **Exceptions card:** if `booking.status` is an exception status, fetch the notice record (may be null → "Not investigated"); show reason/status/photos/reported_at + **"Open investigation" / "View"** actions.
- **Service Tickets card:** fetch `service_ticket` for the booking (`.eq('booking_id', …)`), list subject/status/`display_id`, linking to `/admin/service-tickets/[id]`. Mirrors the resident card.

### 6.2 Resident — `src/app/(public)/booking/[ref]/page.tsx` (+ client)
Already fetches tickets (works) and NCN/NP records (renders only when a record exists). Extend:
- Render the exception card from `booking.status` even when the record is null (minimal "recorded as NCN/NP" state), so record-less exceptions aren't invisible.
- Keep the dispute affordance gated to an existing `Issued` record on own booking (RLS-enforced).
- The dashboard open-investigation filter does **not** apply here — a booking-detail card always shows its own booking's exception regardless of investigation state.

---

## 7. Cross-cutting: data, types, security

- **Migrations:** two views (§4.2) + RLS policy changes (§5.2) via `supabase migration new` → CI `db push` (never MCP `apply_migration` on prod). New RPC/view + consumer in one PR trips Types-Freshness CI, so **the migration ships in the Part-1 PR and the table-client consumers regen types against it** — keep them together only if types are regenerated with the lockfile-pinned CLI; otherwise split per CLAUDE.md §21.
- **Types regen** after the view migration (`pnpm supabase gen types …`, lockfile-pinned CLI; diff vs base to confirm only the new views appear).
- **Views are SELECT-only** — writes still go through the base tables (RLS on those governs). The `openInvestigation` action never writes the view.
- **No Edge Function** needed — server action + RLS is sufficient (no service-role work, no external calls).

## 8. Testing

- **Unit:** view result shaping (investigated vs record-less rows); status-group → filter mapping (badge `Disputed`+`Under Review` vs table default open set).
- **RLS smoke:** staff INSERT (allowed in scope, blocked cross-tenant), `Issued → Under Review` UPDATE, resident dispute still constrained to own `Issued`, field closeout INSERT still works.
- **Server action:** `openInvestigation` — create path (record-less), advance path (Issued→Under Review), reject terminal, NCN reason required, non-staff rejected.
- **E2E:** open-on-behalf from a table row → row moves into the badge/dashboard count; booking-detail cards render for admin + resident.
- Existing NCN/NP detail-page resolution tests must still pass.

## 9. Rollout / phasing (3 PRs → `develop`)

| PR | Scope | Answers |
|---|---|---|
| **1** | Union views + RLS-unaffected table rewrites + badge redefinition + dashboard card/list — the consistency fix | "badge inconsistent with table" |
| **2** | `openInvestigation` action + RLS policy changes + table/card "Open investigation" buttons | "staff open on behalf" |
| **3** | Booking-detail cards (admin Exceptions + Tickets; resident record-less exception card) | "NCN/NP as a card in booking details; check tickets do too" |

PR 1 stands alone and directly resolves the reported bug. PRs 2–3 build on it.

## 10. Open questions (for review)

- **OQ1 — Notify resident when staff open on behalf?** Default: no. Confirm.
- **OQ2 — Capture "opened on behalf" provenance** beyond audit_log (e.g. a stamped note, or a future `opened_by`/`opened_via` column)? Default: rely on audit_log only.
- **OQ3 — Rename dashboard "Open Exceptions" → "Open Investigations"?** Recommended for honesty given the new definition.
- **OQ4 — Table default "open" set** = `{Not investigated, Issued, Disputed, Under Review}` (broader than the badge's `{Disputed, Under Review}`). Confirm this is the intended default view.

## 11. Out of scope

- Changing the field closeout flow or `rollup_booking_status_from_stops`.
- Backfilling notice records for the 5 legacy NCN imports (they surface as "Not investigated" and can be opened on demand).
- Refund / `contractor_fault` / rebook-pricing logic (set at resolution, unchanged — see `ncn-np-workflow`).
- Strata/MUD-specific exception handling beyond what already exists.
- Any change to service-ticket badge/table (already table=all, badge=open).
