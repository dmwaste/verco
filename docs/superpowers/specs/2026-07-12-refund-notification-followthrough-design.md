# Refund notification follow-through

**Date:** 2026-07-12
**Source:** 11/07 pre-cut `/review` (red-team) findings on the refund pipeline.

## Problem

Refunds are raised at four staff sites via `orchestrateRefund`, which returns a
4-value state (`none` / `initiated` / `queued` / `failed`). The resident- and
staff-facing communication was inconsistent and partly dishonest:

1. **Unfulfillable promise.** The `pending_review` refund copy in
   `booking-updated.ts` and `booking-cancelled.ts` promised *"We'll be in touch
   once it's processed"* — but no code path fires when a queued refund is later
   approved (the Refunds-page approve handler and `process-refund` EF send
   nothing). A `-staff` reduction/cancel lands `queued` on the **normal** path,
   so this went out routinely.
2. **NCN/NP silence.** `resolveWithRefund` (NCN) and `resolveNpWithRefund` (NP)
   called `orchestrateRefund` but never notified — the resident saw money land
   on their card with no explanation.
3. **Discarded `failed`.** Both NCN/NP actions threw away the returned state, so
   a `failed` outcome (money owed, **no** Pending row) showed staff a clean
   resolution with only a server console line.

## Decisions

**Finding #1 — soften the copy** (chosen over "notify on approval").
Firing a "refund approved" notification from the generic Refunds flow is
effectively a new feature: a new notification the flow must fire, plus care to
avoid double-notifying the auto-processed path (which already emailed
`processed`). Softening is the surgical fix that makes the copy honest. The
resident still learns a refund is coming and sees the Stripe credit on their
statement — there is just no promise of a second message that nothing sends.

- `pending_review` → *"A refund of $X has been requested and will be returned to
  your original payment method once processed."* (no follow-up promise)
- `for the removed items` dropped from `booking_updated` so the same refund line
  reads correctly when reused by NCN/NP (nothing is "removed" in a resolution).

**Findings #2/#3 — reuse `booking_updated` for NCN/NP.**
The refund is the only resident-facing change, so both resolution actions fire
`booking_updated` **only when a refund was recorded** (`initiated`/`queued`);
`none`/`failed` stay silent to the resident. Reusing `booking_updated` inherits
the PR #406 anti-forgery amount derivation for free: the payload carries
`refund_request_id` (not a cents figure) and `send-notification` derives the
displayed amount from the row. `edit_ref` = the notice id (stable per-resolution
idempotency). Both actions now return `{ refundState, refundAmountCents }`, and
the detail clients surface `failed` as a "process it manually" warning (mirroring
`updateBookingQuantities` / `booking-detail-client`).

**Shared mapping helper.** The `state → refund_status` mapping (duplicated in the
two booking actions) is extracted to `refundStateToNotificationStatus`
(`src/lib/refunds/notification-status.ts`) and used at all four sites so their
refund copy can never drift.

## Not done (deliberately)

- **Notify-on-approval** — see Finding #1 decision. If desired later, it is a
  separate feature (new notification + double-notify guard on the `initiated`
  path).
- The "Booking updated" heading lands for an NCN/NP resolution where the booking
  itself did not change — an accepted minor semantic wrinkle; a dedicated
  template (new type + dispatch branch + mirrors) was judged disproportionate for
  a hardening pass.

## Tests

- `refund-notification-status.test.ts` — the mapping helper (4 states).
- `booking-updated` / `booking-cancelled` / `dispatch` — softened, generalised copy.
- `resolve-exception-refund.test.ts` — NCN + NP: refund raised, `process-refund`
  fired, `booking_updated` payload per state, `failed` → no notification, state
  surfaced in the Result. Both actions run the same battery so they can't drift.
