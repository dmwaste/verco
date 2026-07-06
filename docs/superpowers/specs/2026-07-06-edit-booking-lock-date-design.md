# Lock the collection date on booking edits

**Date:** 2026-07-06
**Status:** Approved — ready for implementation planning
**Type:** Bug fix (wizard flow)
**Scope:** Client-side only. No DB / RLS / Edge Function / RPC changes.

---

## 1. Problem

A resident who wants to **change the services** on an existing booking (fewer, or
different, items) cannot keep their original collection date. If that date has
since **closed** — capacity full, admin-closed, holiday, or T-3 locked — the
booking wizard drops it from the selectable list and forces the resident onto a
different, still-open date.

### Root cause

The "Edit Booking" action reuses the **new-booking wizard** end-to-end:

```
Edit → /book/services → /book/date → /book/details → /book/confirm
```

The launch link ([booking-detail-client.tsx](../../../src/app/(public)/booking/[ref]/booking-detail-client.tsx))
carries `collection_date_id=<original>` and `replaces=<booking.id>`. But the
**Date step** ([date-form.tsx](../../../src/app/(public)/book/date/date-form.tsx))
rebuilds its list with the "can someone start a *new* booking here?" rules:

- `.eq('is_open', true)` — excludes admin/holiday-closed dates
- `.gte('date', today)` — excludes past dates
- capacity filter via `effectiveCapacity()` — excludes full buckets

The resident's already-held date is initialised as `selectedDateId` but is
**absent from the rendered list** when closed, so nothing shows as selected, the
summary chip vanishes, and the first tap on any open date overwrites the
original. On confirm, the in-place edit RPC moves the booking to the newly-picked
date.

### Key finding — the server is already correct

[`update_booking_items_in_place`](../../../supabase/migrations/20260518005935_update_booking_items_in_place_smart_diff.sql)
checks only the capacity **delta** (`new_total − existing_total` per category).
Reductions, no-ops, and within-allocation swaps always pass regardless of how
full or closed the date is; the RPC never reads `is_open` / `locked_closed` /
past. **Re-sending the original closed date with reduced or swapped services is
valid server-side.** The entire bug lives in one wizard routing decision.

---

## 2. Decision

Editing a booking is a **services-only** operation. The collection date the
resident already holds is carried through untouched; the wizard never re-asks for
it. **Self-service rescheduling is removed** (it was only ever an accidental
side effect of reusing the new-booking wizard).

Residents who genuinely need a different date cancel + rebook, or contact
support. Staff retain full date control via the admin inline editor (see §5).

---

## 3. Target flow

```
Before (buggy):   Edit → Services → Date* → Details → Confirm
                                     └─ *rebuilds date list with "new booking"
                                        availability → held date filtered out
                                        if closed → resident forced to move date.

After (fixed):    Edit → Services → Details → Confirm
                                     └─ collection_date_id carried verbatim from
                                        the original booking; Date step skipped.
```

`replaces` (present only on edits) is the single signal that switches the wizard
into edit mode. It is already threaded through every step's `carryParams`.

---

## 4. Changes

All client-side. No migration, no Edge Function, no RPC change.

| # | File | Change |
|---|------|--------|
| 1 | [`services-form.tsx`](../../../src/app/(public)/book/services/services-form.tsx) `handleContinue()` | When `replaces` is set, route to `/book/details` (not `/book/date`), carrying the original `collection_date_id`. Defensive fallback to `/book/date` **only** if `collection_date_id` is unexpectedly absent, so a malformed edit link degrades to today's behaviour rather than a broken step. |
| 2 | [`details-form.tsx`](../../../src/app/(public)/book/details/details-form.tsx) `handleBack()` | When `replaces` is set, route back to `/book/services` (not `/book/date`). |
| 3 | [`date-form.tsx`](../../../src/app/(public)/book/date/date-form.tsx) | Guard: if `replaces` is present on entry (stale link / direct navigation), immediately forward to `/book/details` carrying all params. Makes "date locked" true regardless of entry point and closes the loophole that would otherwise re-open the bug. |
| 4 | [`booking-stepper.tsx`](../../../src/components/booking/booking-stepper.tsx) | Add an **edit** mode whose sequence is **Services → Details → Confirm** (drops both Date and Address, which an edit never touches). New bookings keep the existing 5-step sequence. |

### Stepper design detail

The stepper today takes a numeric `currentStep: 1..5` mapped to a fixed 5-item
`STEPS` array. To support two sequences cleanly:

- Introduce a **semantic** current-step key (`'services' | 'date' | 'details' |
  'confirm'`) plus a `mode: 'new' | 'edit'` (default `'new'`).
- `mode` selects the sequence: `STEPS_NEW` (Address, Services, Date, Details,
  Confirm) or `STEPS_EDIT` (Services, Details, Confirm). The highlighted index is
  derived from the key's position within the active sequence.
- Each form passes its own step key and, when `replaces` is present, `mode="edit"`.

This decouples the forms from hard-coded positions and lets the same components
render either sequence. (Exact prop shape is an implementation detail for the
plan; the requirement is: edit renders Services → Details → Confirm, new renders
the current 5 steps.)

---

## 5. Admin parity

`services-form.tsx` is shared: the admin "Edit services" launch
([admin/bookings/[id]/booking-detail-client.tsx](../../../src/app/(admin)/admin/bookings/[id]/booking-detail-client.tsx))
enters the same wizard with `replaces`. The `replaces` branch therefore fixes
**both** resident and admin wizard-edits in one change.

Admin loses no capability: date/location/notes changes stay on the admin
**inline "Save details" editor** (`handleSaveDetails` → `updateCollectionDetails`,
using its own `editDateId` picker), which is independent of the wizard.

> Out of scope: whether the admin inline date picker itself can select a closed
> date is a separate concern from this bug and is **not** addressed here.

---

## 6. Edge cases (correct-by-design)

These are already handled correctly by the server once the date is locked; the
spec records them so they aren't mistaken for regressions.

- **Adding *more* items on a genuinely full date** → the RPC's delta check
  rejects with "Insufficient capacity", surfaced in the confirm step's
  `submitError`. Correct: you cannot add paid extras to a full date. The reported
  case ("less or different") always passes.
- **Cross-category swap** (e.g. drop 1 bulk, add 1 ancillary) where the target
  bucket on that date is full → the `+1` delta fails server-side. Correct.
- **Within-allocation / same-total change** → delta ≤ 0 per category → always
  passes, even on a fully-closed date. This is the reported case and the primary
  path to protect.

---

## 7. Testing

| Level | Test |
|-------|------|
| E2E (regression for the report) | Resident edits services **down** on a booking whose collection date is capacity-full → the same `collection_date_id` persists end-to-end and the booking is updated in place (no date change). Add to `tests/e2e/`. |
| Component | `services-form` in edit mode (`replaces` present) routes to `/book/details` with the original `collection_date_id` preserved. |
| Component | `details-form` back button in edit mode returns to `/book/services`. |
| Component | `date-form` guard forwards to `/book/details` when `replaces` is present on entry. |
| Component | `booking-stepper` renders **Services → Details → Confirm** in edit mode and the full 5 steps otherwise. |
| Regression (unchanged) | A brand-new booking still walks Address → Services → Date → Details → Confirm and can pick any open date. |

---

## 8. Non-goals

- **Resident self-reschedule** — deliberately removed. No new "change date"
  affordance is added.
- **Admin inline date-editor filtering** — separate concern, not touched.
- **`update_booking_items_in_place` RPC** — no change; already correct.
- **Optional polish, flagged not built:** a one-line hint on the booking detail
  such as *"To change your collection date, cancel and rebook or contact us."*
  Can be added later if support volume warrants it.

---

## 9. Rollout notes

- Pure client change → ships in a normal `develop → main` batch; no migration
  ordering, no EF deploy, no types regen.
- No feature flag needed — the behaviour change is scoped to the `replaces` edit
  branch and is strictly safer than today.
