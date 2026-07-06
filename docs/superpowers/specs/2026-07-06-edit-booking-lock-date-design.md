<!-- /autoplan restore point: /Users/danieltaylor/.gstack/projects/dmwaste-verco/claude-nervous-bohr-94bca0-autoplan-restore-20260706-145233.md -->
# Make the booking-edit Date step edit-aware (keep the held date)

**Date:** 2026-07-06
**Status:** Approved scope after /autoplan review + product correction — ready for implementation planning
**Type:** Bug fix
**Scope:** Client-side (one date-step change + a calendar token) plus a ~3-line Edge Function tweak. No new flow, no migration, no stepper rework.

---

## 1. Problem

A resident changing the **services** on an existing booking cannot keep their
original collection date. If that date has since **closed** (capacity full,
admin-closed, holiday, or T-3 locked) the booking wizard's Date step drops it from
the selectable list and forces the resident onto a different, still-open date.

### Root cause

"Edit Booking" reuses the new-booking wizard
([booking-detail-client.tsx:721](../../../src/app/(public)/booking/[ref]/booking-detail-client.tsx#L721)):
Services → **Date** → Details → Confirm, carrying `collection_date_id=<held>` and
`replaces=<booking.id>`. The **Date step**
([date-form.tsx:82-136](../../../src/app/(public)/book/date/date-form.tsx#L82))
builds its list with the "can someone start a *new* booking here?" filter:

- `.eq('is_open', true)` — excludes admin/holiday-closed dates
- `.gte('date', today)` — excludes past dates
- `effectiveCapacity()` capacity filter — excludes full buckets

The held date is set as `selectedDateId` but is **absent from the rendered list**
when closed, so nothing shows as selected and the first tap on any open date
overwrites it. On confirm, the in-place edit RPC moves the booking off its date.

The filter is correct for a *new* booking and wrong for an *edit* of a booking
that already holds a date.

---

## 2. Decision (scope corrected)

**Make the Date step edit-aware. Do not skip it, do not build a new flow.**

Date-change in isolation already exists for both audiences and must be preserved:

- **Staff:** the admin inline editor (`editDateId` →
  [`updateCollectionDetails`](../../../src/app/(admin)/admin/bookings/[id]/actions.ts#L297),
  gated by [`canEditCollectionDetails`](../../../src/lib/booking/collection-details-edit.ts)).
- **Resident:** the same wizard Date step — leave quantities, pick a new date.

So neither *removing* the Date step from edits (loses resident reschedule) nor
*building* a separate "Change date" action (rebuilds something that exists) is
right. The fix is to stop the Date step from filtering out the date the resident
already holds.

**Change:** when `replaces` is present, the held `collection_date_id` is always
present in the picker, **pre-selected** and labelled "Current date" — even when now
closed. Candidate *other* dates keep the normal open+capacity filter, so a resident
can only move onto a date with real headroom.

| Intent | After the fix |
|---|---|
| Change **services**, keep the (closed) held date | Held date pinned + pre-selected → click Next, date preserved. **Bug fixed.** |
| Change the **date** | Same Date step, pick another open date. **Unchanged.** |
| Staff change date in isolation | Admin inline editor. **Untouched.** |

---

## 3. Changes (in scope)

| # | File | Change |
|---|------|--------|
| 1 | [`date-form.tsx`](../../../src/app/(public)/book/date/date-form.tsx) | When `replaces` is present: fetch the held `collection_date` row by id (public-SELECT, anon-readable — it may be absent from the filtered list), inject it into `calendarDates` with the new `'current'` status, and pre-select it (`selectedDateId` already initialises from the param). Candidate other dates keep the existing open+capacity filter. Guard against duplicating the held date if it *is* already in the list. |
| 2 | [`calendar.ts`](../../../src/lib/booking/calendar.ts) + [`availability-calendar.tsx`](../../../src/components/booking/availability-calendar.tsx) | Add a 4th `DateStatus` `'current'` (additive — existing consumers never pass it). Give it a **neutral/brand** chip (NOT the red `closed` style, which would render the resident's own booking as an error — the review's critical design finding), the selection ring, a "Current date" summary pill + legend entry, and an accessible label ("Current booking date — keeping it does not change your booking"). |
| 3 | [`create-booking` EF](../../../supabase/functions/create-booking/index.ts#L192) (`if (!collDate.is_open)`, L192) | Make the `is_open=false` guard **edit-aware**: when `replaces` is set AND `collection_date_id` equals the booking's current date, allow it (so an admin-closed/holiday *held* date passes). A *different* target date still gets the full bookable check. Without this, the client pin works but the EF rejects an `is_open=false` held date — covers all closure reasons, not just capacity-full. |
| 4 | [`confirm-form.tsx`](../../../src/app/(public)/book/confirm/confirm-form.tsx) `handleBack()` (~L644) | Carry `replaces` through the back-nav params. Today it's dropped, so Confirm → Back → Next silently loses edit mode (re-submits as a new booking). Small, on the exact path being fixed. |
| 5 | [`confirm-form.tsx`](../../../src/app/(public)/book/confirm/confirm-form.tsx) FY-usage query (~L233) | Exclude the `replaces` booking from the confirm-step FY-usage preview, matching [`services-form.tsx:99-127`](../../../src/app/(public)/book/services/services-form.tsx#L99). Today confirm counts the booking against itself, so extras can display differently from the services step and the EF. |

Changes 1–2 fix the reported (capacity-full) case entirely client-side. Change 3
extends the fix to admin-closed/holiday held dates. Changes 4–5 are small
correctness fixes on the edit path, rolled in because we're already there.

---

## 4. Findings triage (from the /autoplan dual-voice review)

The review (CEO + Design + Eng, Claude subagent + Codex each) ran against an
earlier, over-scoped draft. Triaged against the corrected scope:

**Rolled in (§3):** edit-aware Date step; the `'current'` calendar token (the one
critical design finding — held date must not render red); EF `is_open` edit-aware;
confirm back-nav `replaces`; confirm FY-usage exclusion.

**Flagged — pre-existing, NOT this bug, recommend separate tickets:**

| Finding | Why separate |
|---|---|
| **IDOR** — the `replaces` edit branch calls the RPC via service-role with no ownership check ([create-booking EF](../../../supabase/functions/create-booking/index.ts) edit branch). | Exists today for both resident + admin edits; independent of this bug. Real; deserves its own security fix. |
| **No cutoff enforcement on edits/moves** — `enforce_cancellation_cutoff` fires only on `status → Cancelled`, so a booking_item date/service change after the 3:30pm cutoff is server-unguarded. | Pre-existing on the edit path; not introduced here. |
| **Capacity delta gap on a pure date-move** — `update_booking_items_in_place` checks a *delta* that is 0 for a same-items move, so a move can overfill a full target (masked only by the UI filter). | Pre-existing; any wizard date-change hits it today. The edit-aware Date step keeps the same UI guarantee (candidate dates still filtered to headroom; the held date is a no-op). Server hardening is its own item. |
| **Paid bookings can't edit/reschedule** — the EF rejects `total_cents>0` on an edit. | Pre-existing wizard limitation, not caused by this change. |

**Dropped (over-scope the correction removed):** a new "Change date" action; skipping
the Date step; edit-mode stepper + 5-call-site rework; the booking-detail button
redesign. None are needed — the Date step stays, so the stepper and action row are
untouched.

---

## 5. Edge cases (correct-by-design)

- **Held date capacity-full** (the reported case): `is_open=true`, so the EF passes;
  the RPC delta check passes for a reduction/same-total; UI pins the held date. Works
  end-to-end with changes 1–2 alone.
- **Held date admin-closed/holiday** (`is_open=false`): needs change 3 or the EF
  rejects it. With change 3, works.
- **Resident moves to another date**: candidate list still filtered to open+capacity,
  so no overfill via the UI (same guarantee as today).
- **Adding paid extras on a full held date**: RPC delta check correctly rejects
  (insufficient capacity); surfaced in confirm's `submitError`.

---

## 6. Testing

| Level | Test |
|-------|------|
| E2E (regression for the report) | Resident reduces services on a booking whose held date is **capacity-full** → held date shows pinned + pre-selected as "Current date", resident keeps it, booking updated in place on the same date. |
| Component | `date-form` in edit mode (`replaces`) injects + pre-selects the held date even when closed; renders it with the `'current'` token, not `closed`; candidate other dates still exclude full buckets. |
| Component | Regression: a **new** booking Date step is unchanged (no `'current'` cell; open+capacity filter intact). |
| Component | Resident can still move to another open date in edit mode (date-change-in-isolation preserved). |
| Component | `confirm-form` back-nav preserves `replaces`; confirm FY-usage preview excludes the edited booking. |
| EF | Edit on an `is_open=false` **held** date succeeds; a *different* non-bookable target still rejected. |

---

## 7. Rollout

- Changes 1, 2, 4, 5: client-side; ship in a `develop → main` batch.
- Change 3: Edge Function deploy (`create-booking`) with the back-compat pattern
  (edit-aware branch is additive; new-booking path unchanged).
- No migration. No types regen (no schema change).
- The flagged pre-existing items (§4) → separate security/hardening tickets; not
  gated on this fix.
