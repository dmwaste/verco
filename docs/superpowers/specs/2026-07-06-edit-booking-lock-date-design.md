<!-- /autoplan restore point: /Users/danieltaylor/.gstack/projects/dmwaste-verco/claude-nervous-bohr-94bca0-autoplan-restore-20260706-152715.md -->
# Make the booking-edit Date step keep the held date (edit-aware)

**Date:** 2026-07-06
**Status:** Approved after two /autoplan passes — ready for implementation
**Type:** Bug fix
**Scope:** Client-side only. No migration, no Edge Function change, no RLS/RPC change, no types regen.

---

## 1. Problem

A resident changing the **services** on an existing booking cannot keep their
original collection date. If that date has since **closed** (capacity full or
T-3 locked) the wizard's Date step drops it from the selectable list and forces
the resident onto a different, still-open date.

### Root cause

"Edit Booking" reuses the new-booking wizard
([booking-detail-client.tsx:721](../../../src/app/(public)/booking/[ref]/booking-detail-client.tsx#L721),
entry is cutoff-gated by `canCancel`): Services → **Date** → Details → Confirm,
carrying `collection_date_id=<held>` and `replaces=<booking.id>`. The Date step
([date-form.tsx:82-136](../../../src/app/(public)/book/date/date-form.tsx#L82))
builds its list with the "new booking" filter — `.eq('is_open', true)`,
`.gte('date', today)`, and an `effectiveCapacity()` capacity filter. A closed held
date passes the query (capacity/lock closure keeps `is_open=true`) but is dropped
by the capacity filter, so it never renders. `selectedDateId` initialises to the
held id but nothing shows selected; the first tap on any open date overwrites it.

The filter is correct for a *new* booking and wrong for an *edit* that already
holds a date.

---

## 2. Decision

**Make the Date step edit-aware — keep the held date, don't remove or rebuild.**

Date-change in isolation already exists for both audiences and stays untouched:
- **Staff:** admin inline editor (`editDateId` → `updateCollectionDetails`, gated by
  [`canEditCollectionDetails`](../../../src/lib/booking/collection-details-edit.ts)).
- **Resident:** the same wizard Date step — leave quantities, pick a new date.

So neither skipping the Date step (loses resident reschedule) nor building a new
"Change date" flow (rebuilds what exists) is right. The fix: when `replaces` is
present, the held date is **kept in the picker, pre-selected**, and labelled
"Current date" via a new neutral calendar token.

**Reach (settled at review):** covers held dates that are **capacity-full or
T-3-locked** (`is_open=true`) — this is the reported bug. **Admin-closed / holiday
held dates (`is_open=false`) are out of scope:** the `collection_date` public-read
RLS policy is `USING (is_open = true)`, so an anon resident cannot read such a row
at all — supporting it would need a new anon read path (RPC or scoped RLS), not
worth it for an admin-deliberate closure. See §5.

| Intent | After the fix |
|---|---|
| Change **services**, keep the (capacity-full/locked) held date | Held date kept + pre-selected as "Current date" → click Next, date preserved. **Bug fixed.** |
| Change the **date** | Same Date step, pick another open date. **Unchanged.** |
| Staff change date in isolation | Admin inline editor. **Untouched.** |

---

## 3. Changes (all client-side)

| # | File | Change |
|---|------|--------|
| 1 | [`date-form.tsx`](../../../src/app/(public)/book/date/date-form.tsx) (`availableDates`/`calendarDates`, L129-150) | When `replaces` is set: **keep** the held `collection_date_id` in the list instead of capacity-filtering it out, and **hard-set its status to `'current'`** — do NOT run the held row through the `spotsRemaining → status` derivation (pooled/VV areas keep `collection_date.*` counters at 0, which would collapse it to `closed`). It is already in the fetched `dates` for the supported cases (`is_open=true`), so no extra query. `selectedDateId` already initialises from the param; render the "Current date" summary pill for the `'current'` status. |
| 2 | [`calendar.ts`](../../../src/lib/booking/calendar.ts) + [`availability-calendar.tsx`](../../../src/components/booking/availability-calendar.tsx) | Add a 4th `DateStatus` `'current'`: entry in `STATUS_LABEL` and `STATUS_CHIP` (TS `Record` forces both — a safety net), a **neutral/brand** chip (NOT the red `closed` style, which would render the resident's own booking as an error), update the aria-label ternary at [L157-163](../../../src/components/booking/availability-calendar.tsx#L157) (else it announces "available"), and render any "Current date" legend entry **only when** `dates.some(d => d.status === 'current')` so new-booking + admin ID-intake callers get no stray copy. |
| 3 | [`confirm-form.tsx`](../../../src/app/(public)/book/confirm/confirm-form.tsx) `handleBack()` (L638-661) | Carry `replaces` through the back-nav params. Today it's dropped, so Confirm → Back → Next re-enters without `replaces` and creates a **duplicate booking** (both review voices confirmed). `swap` is dropped the same way — flag as the same bug class, do not fix here. |
| 4 | [`confirm-form.tsx`](../../../src/app/(public)/book/confirm/confirm-form.tsx) FY-usage query (L234-241) **and** its `summaryData` queryKey (L193) | Exclude the `replaces` booking from the confirm-step FY-usage preview (matches [`services-form.tsx:125-127`](../../../src/app/(public)/book/services/services-form.tsx#L125)); today confirm counts the booking against itself so extras can display differently from the services step and the EF. **Also add `replacesParam` to the `summaryData` queryKey**, or a soft-nav serves stale cached usage. |

Changes 1–2 fix the reported bug. Changes 3–4 are small correctness fixes on the
exact edit path — both review voices judged them load-bearing, not scope creep.

---

## 4. Findings triage (two /autoplan passes)

**Rolled in (§3):** keep-the-held-date + hard-set `'current'` (pooled-safe); the
`'current'` token with aria-label + conditional legend; confirm back-nav `replaces`;
confirm FY-usage exclusion + queryKey.

**Dropped as unnecessary under the narrow scope:** the earlier "EF `is_open`
edit-aware" change — the held date is always `is_open=true` in the supported cases,
so the EF's existing guard already passes it. No EF change.

**Out of scope — pre-existing, NOT this bug (separate security ticket, spawned):**

| Finding | Why separate |
|---|---|
| **IDOR** — the `replaces` edit branch calls the RPC via service-role with no ownership check. | Exists today for resident + admin edits; independent of this bug. |
| **No cutoff enforcement on the RPC** — a booking_item date/service change isn't guarded by `enforce_cancellation_cutoff` (status-only trigger). | Pre-existing. Resident *entry* is cutoff-gated in the UI (`canCancel`), so the resident path is protected upstream; the server gap remains. |
| **Capacity delta-0 on a pure date-move** — a same-items move can overfill a full target. | Pre-existing; UI candidate filter is the guard (unchanged here). |
| **Paid bookings can't edit** — EF rejects `total_cents>0`. | Pre-existing wizard limitation. |
| **Admin-closed/holiday held date** — RLS `is_open=true` blocks the client read. | Rare admin-deliberate closure; supporting it needs a new anon read path. Deliberately unsupported. |

**Dropped (over-scope from the first pass):** a new "Change date" action; skipping
the Date step; edit-mode stepper + call-site rework; the booking-detail button
redesign. The Date step stays, so the stepper and action row are untouched.

---

## 5. Edge cases

- **Capacity-full held date** (the report): `is_open=true`, returned by the Date
  query, kept + marked `'current'`. Fixed by changes 1–2.
- **T-3-locked held date**: `is_open=true` (lock sets `*_is_closed`, not `is_open`),
  same path as capacity-full. Fixed.
- **Pooled/VV area**: held row's counters are 0 by design → must hard-set `'current'`
  (change 1), else it collapses to `closed`.
- **Admin-closed/holiday held date** (`is_open=false`): unsupported (RLS blocks the
  read); resident is still rerouted, as today. Documented, not a regression.
- **Past-cutoff / past-date held date**: not reachable — the edit entry is gated by
  `canCancel` (3:30pm-prior cutoff), so the held date is always ≥ tomorrow.
- **Resident moves to another date**: candidate list still open+capacity filtered →
  no overfill via the UI (same guarantee as today).

---

## 6. Testing

| Level | Test |
|-------|------|
| E2E (regression for the report) | Resident reduces services on a booking whose held date is **capacity-full** → held date shows pinned + pre-selected as "Current date", resident keeps it, booking updated in place on the same date. |
| Component | `date-form` edit mode (`replaces`) keeps + marks the held date `'current'` for **both** capacity-full and T-3-locked; new-booking Date step unchanged (no `'current'` cell, filter intact). |
| Component | **Pooled/VV** area: injected held date renders `'current'`, not collapsed to `closed`. |
| Component | Resident can still move to another open date in edit mode (date-change-in-isolation preserved). |
| Component | `'current'` legend renders only when a `'current'` cell exists (absent for new bookings / admin ID intake); aria-label announces "current booking date". |
| Component | `confirm-form` back-nav preserves `replaces`; FY-usage preview excludes the edited booking and its queryKey includes `replacesParam`. |

---

## 7. Rollout

- All changes client-side → ships in a single `develop → main` batch.
- No migration, no Edge Function deploy, no RLS/RPC change, no types regen.
- Pre-existing items (§4) → the spawned security/hardening ticket; not gated on this fix.

---

## /autoplan audit (two passes)

- **Pass 1** (CEO/Design/Eng, dual voices) surfaced that "remove resident
  reschedule" was unproven (0/18 date changes were resident-initiated; the WMRC
  guide documents the capability) and that the edit path carries pre-existing
  IDOR + cutoff + capacity-delta gaps. Product correction: date-change already
  exists in isolation, so the fix is the edit-aware Date step, not a new flow.
- **Pass 2** (this scope) confirmed the fix correct and correctly scoped, found the
  RLS `is_open=true` read constraint (→ narrow reach), and hardened the
  implementation details (pooled hard-set `'current'`, aria-label, confirm
  back-nav/FY-usage queryKey). Both "adjacent" changes confirmed load-bearing.
- Decisions: keep reschedule as-is (not remove, not rebuild); narrow reach to
  `is_open=true` held dates; drop the EF change; security gaps → separate ticket.

---

## Addendum — admin date-override for D&M staff (#378, BR-0023 / BR-0025)

**Date:** 2026-07-11
**Status:** Decided by Dan Taylor (MD, 2026-07-11 triage on #378); implemented via the bug lane.
**Type:** Bug fix — the admin counterpart to the resident-side change above.
**Scope:** Application-layer only (admin inline date editor + its server action + one
pure guard). No migration, no EF, no RLS/RPC change, no types regen.

### Problem (two reports)

- **BR-0023:** a council (client-tier) admin can't change the collection date on a
  "previous" booking — one already `Scheduled`/`Completed` — when a crew collected on
  the wrong day and the record needs correcting.
- **BR-0025:** an admin can't move a booking to an **earlier** date, or onto a date that
  has been **closed off** (`collection_date.is_open = false`).

Root cause (confirmed via `/investigate`): the admin inline date-picker
(`booking-detail-client.tsx`) hard-filtered `is_open = true AND date >= today` — identical
to the resident flow — and the `canEditCollectionDetails` gate allowed no post-`Confirmed`
edit except contractor-on-`Scheduled` (VER-285). `updateCollectionDetails` re-validated
**nothing** about the target date, so the restriction lived entirely in the dropdown filter.

### Decision (Dan, MD — do not re-litigate)

- **D1 — override scope:** only **contractor-tier (D&M) staff** (`contractor-admin`,
  `contractor-staff`) may reschedule a booking into a **closed** (`is_open = false`) or
  **past/earlier** date. Client-tier (council) admins cannot back-date.
- **D2 — post-dispatch editability:** only contractor-tier staff may edit a booking's
  collection date once it is `Scheduled` / dispatched / `Completed`, to correct a crew
  collection error. `Completed` is added to the contractor-only editable set (Scheduled was
  already there, VER-285). The exception/rebook states (Non-conformance, Nothing Presented,
  Rebooked, Missed Collection) keep their dedicated NCN/NP rebook flow and are **not**
  editable here. All other roles remain pre-dispatch only.
- **Capacity default (confirmed):** a staff date-override **moves** the existing booking —
  it keeps its already-consumed allocation and is **not** re-gated by the target date's
  `is_open`/capacity check. It's a correction, not a new booking competing for a slot.
  Verified against `recalculate_collection_date_units()` (migration `20260518005934`): the
  trigger re-sums **both** the old and new dates on the `booking_item` date-change UPDATE
  (absolute re-sum, not a delta), so no slot is double-counted and the old slot is correctly
  freed. Pricing/allocation (`unit_price_cents`/`is_extra`) is untouched by a date move.

### Changes (all application-layer)

| # | File | Change |
|---|------|--------|
| 1 | `src/lib/booking/collection-details-edit.ts` | Add `Completed` to a `CONTRACTOR_POST_DISPATCH_EDITABLE` set (`canEditCollectionDetails` → contractor-only). Add pure `canRescheduleToTargetDate(role, {is_open, date}, today)` — closed/past target ⇒ contractor-only; open+future ⇒ no extra privilege. Both route through the shared `isContractorStaff` helper. |
| 2 | `src/app/(admin)/admin/bookings/[id]/actions.ts` | `updateCollectionDetails`: on a date change, fetch the target's `is_open`/`date` and re-check `canRescheduleToTargetDate` **server-side** before the write — the client filter is a convenience, not the security boundary. |
| 3 | `src/app/(admin)/admin/bookings/[id]/booking-detail-client.tsx` | Relax the picker's `is_open`/`date` filter for contractor-tier staff only (both the per-area and pooled-date queries); annotate closed/past options (`· closed, past`) so the override is deliberate. |

### Testing

- `src/__tests__/collection-details-edit.test.ts` — 15 pure-guard tests (100% of the decision
  logic): contractor can edit `Completed`; client-tier blocked on `Scheduled`/`Completed`;
  `canRescheduleToTargetDate` for open/closed/past × contractor/client/null.
- Full suite (1358), typecheck, lint, and a production build (`/admin/bookings/[id]` route)
  all clean.

### Security note (deferred, follow-up)

The closed/past rule is enforced in the server action; `booking_item_staff_update` RLS
(unchanged) still permits any admin-tier role to UPDATE `booking_item` directly. This
direct-PostgREST bypass is **pre-existing** (already applied to the VER-285 status gate) and
tenant-local. DB-layer enforcement (RLS `WITH CHECK` / trigger mirroring
`create_id_booking_with_capacity_check`) is captured as a separate hardening ticket — same
triage as the §4 IDOR/cutoff/capacity-delta gaps.
