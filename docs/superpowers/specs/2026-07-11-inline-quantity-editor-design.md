# Inline quantity editor on the admin booking-detail card (issue #380 / BR-0028)

**Date:** 2026-07-11
**Status:** Draft — awaiting design sign-off on the PR-B payment-path approach
**Type:** Feature
**Issue:** [#380](https://github.com/dmwaste/verco/issues/380) — "Option 1: build the inline quantity editor" (Dan, MD, 2026-07-11)
**Scope decision (Dan, 2026-07-11):** EXPANDED beyond the issue's original hard
constraint to also build a Stripe payment path for quantity increases that cross
into paid extras (see §2). This makes the work money-critical and multi-PR.

---

## 1. Problem

An admin cannot change a booking's per-service quantities (`no_services`) while
keeping the same collection date. The admin booking-detail "Collection Details"
card ([booking-detail-client.tsx:591-666](../../../src/app/(admin)/admin/bookings/[id]/booking-detail-client.tsx#L591))
edits **Location / Collection Date / Notes only** — there is no quantity field.
The only path to change quantity is the "Edit services" pencil
([:167-191](../../../src/app/(admin)/admin/bookings/[id]/booking-detail-client.tsx#L167)),
which routes staff through the **full public 5-step booking wizard**
(`/book/services … → confirm`). That is heavy for a "bulk 3 → 1" tweak and — per
the reported bug (BR-0028) — feels like it risks the collection date (the wizard
does preserve it in the common case, but the round-trip is the complaint).

**This is a feature gap, not a wizard bug** (confirmed in the #380 investigation).

---

## 2. Decision

Add an **in-place quantity editor** to the Collection Details card. It reuses the
**existing in-place edit engine** — the `create-booking` Edge Function invoked
with `replaces` → `update_booking_items_in_place` RPC — the same path the wizard
"Edit services" flow already uses ([confirm-form.tsx:366-439](../../../src/app/(public)/book/confirm/confirm-form.tsx#L366)).
It never re-selects the date (same `collection_date_id` throughout — the entire
point of the issue).

### The engine's real capabilities (verified, corrects the issue comment)

The issue's decision comment claims the engine "already handles price delta,
refund." **It does not.** Reading the code:

- The EF `replaces` branch **hard-rejects any edit landing at `total_cents > 0`**
  ([create-booking/index.ts](../../../supabase/functions/create-booking/index.ts):
  *"In-place edit cannot introduce new paid services. Cancel and rebook"*). So an
  **increase into paid is not supported today** — it returns HTTP 400.
- `update_booking_items_in_place` does a **capacity** refund (frees the date's
  counters) + a smart audit diff. It issues **zero money movement** — no
  `refund_request`, no Stripe. (Contrast the cancel flow, which explicitly
  creates a `refund_request` + calls `process-refund`.)
- The state machine has **no** `Confirmed → Pending Payment` transition and **no**
  incremental/partial-charge concept. `create-checkout` only runs for
  `Pending Payment` and charges the booking's **entire** paid-extra total.

The "paid bookings can't edit" wall is a *known, deliberately-deferred* limitation
(see `docs/superpowers/specs/2026-07-06-edit-booking-lock-date-design.md` §4 and
memory `booking-edit-path-architecture`). #380's expanded scope removes it.

### Money-behaviour decisions (Dan, 2026-07-11 — updated after stress-test)

| Case | Decision |
|---|---|
| **Reduction that owes money back** | **Allow** the in-place edit; **auto-refund `|delta|` via the existing `refund_request` + `process-refund` machinery** (identical to `cancelBooking`). Keeps the money ledger honest so the re-priced baseline stays trustworthy. *(Supersedes the initial "manual, don't touch the ledger" choice — the stress-test proved it leaks; §11 #3 / §11a.)* |
| **Increase that creates a new paid extra** | **Deferred to PR-B** — a separate follow-up issue for the Stripe delta-charge subsystem. In **PR-A** an increase into paid (`delta > 0`) is **blocked** with a "Cancel & rebook" message. *(Dan, 2026-07-11: "ship editor + reductions now, PR-B follow-up" — the stress-test revealed PR-B is a substantial money subsystem, §5 + §11 #4/#6/#8/#9.)* |
| **Price drift** (`baseline ≠ collected`) | **Block** the inline edit, route to Cancel & rebook (§3 drift guard). |

**Decisions LOCKED (2026-07-11), this session builds PR-A only:**
- Re-price delta model + drift hard-block (§3 v2).
- Reductions auto-refund via existing machinery (server action orchestrates, mirrors
  `cancelBooking`; the EF returns `refund_owed_cents`).
- The widened "allow `delta ≤ 0` paid reduction + return `refund_owed`" behaviour in
  the `create-booking` `replaces` branch is **gated to the inline editor** (an
  explicit request flag) so the shared wizard edit path is unchanged (no new leak).
- Increases (`delta > 0`) blocked in PR-A → PR-B follow-up issue (§5 + §11 as its spec).
- PR-A is client + one server action + a gated EF-guard change + a pure decision
  module. **No migration, no new EF, no webhook, no state-machine change.**

---

## 3. The pricing / delta model (authoritative for the whole feature)

> **v2 — corrected after adversarial money-safety review (2026-07-11).** v1 used
> `already_paid = SUM(paid booking_payment)` as the delta baseline. That is a
> *frozen historical settled amount*; comparing it to a freshly re-priced
> `new_total` moves money the wrong way whenever FY state drifted since booking
> (interim other bookings, never-settled Pending Payment, prior manual refund,
> `extra_unit_price` change) — including the pathological *"reduce a unit, get
> charged more."* See §11.

All amounts are server-computed. The client only previews (display-only, mirrors
`services-form.tsx`). On save, the server re-runs the engine and is the source of
truth (Red Line #1). **Both** sides of the delta are computed with the **same
engine call under the same current FY state:**

```
baseline_total  = calculatePrice(CURRENT persisted items, exclude THIS booking,
                                  honouring category cap + THIS booking's active swap)
new_total       = calculatePrice(NEW items,               exclude THIS booking, … same swap)
delta_cents     = new_total − baseline_total          // re-price DIFFERENCE, not vs. history

collected_cents = SUM(booking_payment.amount_cents) WHERE booking_id = X AND status = 'paid'
```

**Drift guard (mandatory).** For a *settled* booking (has ≥1 `paid` payment),
if `baseline_total ≠ collected_cents` the booking's price has drifted from what was
actually collected → **hard-block the inline edit and route to Cancel & rebook.**
An automated charge/refund on a drifted booking would be wrong (§11 #1, #5). A
*free* booking (`collected = 0`) whose `baseline_total` re-prices `> 0` is the same
drift case → blocked. `Pending Payment` bookings never use this delta path (§11 #2).

| `delta_cents` | Meaning | Path |
|---|---|---|
| `= 0` | No change in money owed (free-quota change, or same-price swap) | In-place update. No money. |
| `< 0` | Resident is owed money back | In-place update **+ refund of `|delta|`** — see §2 decision (revisited in §11 #3). |
| `> 0` | Resident owes more | **Delta Stripe charge** for `delta_cents`; added items applied on payment success. |

The collection date is **never changed** by this editor — `collection_date_id`
is passed through unchanged, so the RPC's date-move branch is a no-op and the
capacity check runs against the same-date category delta only.

Because `baseline_total` re-prices the *current* items, a prior manual reduction
is naturally reflected (fixes the §11 #3 leak) **iff** reductions keep the money
ledger consistent — hence the §11 #3 decision below.

### Full behaviour matrix

| # | Start state | Edit | `delta` | Behaviour | PR |
|---|---|---|---|---|---|
| 1 | Free (all included) | 3 → 1, still all free | 0 | RPC updates qty. No money. | A |
| 2 | Free | 1 → 4, still within free allocation | 0 | RPC updates qty. Capacity re-checked (positive category delta). | A |
| 3 | Paid+settled (`$X`) | reduce so it becomes free-only | `−X` (<0) | RPC deletes paid line, updates free line. **Warn: refund `$X` manually.** | A |
| 4 | Paid+settled (`$X`) | reduce paid units, still `$Y` paid (`0<Y<X`) | `−(X−Y)` (<0) | RPC lowers paid `no_services`. **Warn: refund `$(X−Y)` manually.** | A |
| 5 | Pending Payment (never settled) | reduce | ≤0 | RPC updates qty. No refund (nothing paid). Handle open Stripe session (see §5). | A |
| 6 | Free Confirmed (`already_paid=0`) | increase so 1 unit becomes paid | `+P` (>0) | **Delta checkout `= new_total`.** Item applied on webhook success. | B |
| 7 | Paid+settled (`$X`) | increase further to `$X+P` | `+P` (>0) | **Delta checkout `= P`** (not `X+P`). Applied on webhook. | B |
| 8 | **MUD** booking | any | — | Editor hidden; "Cancel & rebook" hint (mirror `editServicesUrl` MUD exclusion, [:160-166](../../../src/app/(admin)/admin/bookings/[id]/booking-detail-client.tsx#L160)). | — |
| 9 | Any allocation **swap** applied | any | per engine | Engine + EF already reconcile the swap on edit (`allocation_swap` upsert/delete). Preserve — don't double-count. | A/B |

---

## 4. PR-A — the editor + all non-charging paths (`delta_cents ≤ 0`)

Ships fast, high value, **no new money movement**. Reuses the engine as-is; the
only server change is **loosening the EF guard from absolute `total_cents > 0` to
`delta_cents > 0`** so reductions of paid bookings (rows 3–5) can flow through
(the EF loop already builds paid `booking_item` rows — it just never reaches them
today).

| # | File | Change |
|---|---|---|
| A1 | [booking-detail-client.tsx](../../../src/app/(admin)/admin/bookings/[id]/booking-detail-client.tsx) Collection Details card | Add a per-service **quantity editor** (stepper/number input per line, mirroring the Services card items at [:798-828](../../../src/app/(admin)/admin/bookings/[id]/booking-detail-client.tsx#L798)). Client-side price **preview** (reuse the `services-form` dual-limit preview logic — display only). Gate on `canEditCollectionDetails(status, role)` — identical to the rest of the inline editor. Hidden for MUD (row 8). If preview `delta > 0` → block save with a "Cancel & rebook to add paid extras" hint (PR-A; PR-B replaces this with the payment path). If preview shows a refund owed → prominent warning. |
| A2 | `admin/bookings/[id]/actions.ts` | New server action `updateBookingQuantities(bookingId, items)`. Role gate (`current_user_role()` ∈ admin roles) + `canEditCollectionDetails`. Calls the `create-booking` EF with `replaces=bookingId`, the new `items`, and the booking's **current** `collection_date_id`/`location`/`contact` (same envelope the wizard sends). Uses the user JWT (staff on-behalf). Returns the EF result incl. any refund-owed amount for the UI warning. **No hand-rolled `booking_item` write, no refund/pricing logic** (Red Line: reuse the engine). |
| A3 | [create-booking/index.ts](../../../supabase/functions/create-booking/index.ts) `replaces` branch | Change the guard: read `already_paid_cents` (SUM of paid `booking_payment`), compute `delta = priceResult.total_cents − already_paid_cents`; **reject only when `delta > 0`** (message unchanged for PR-A: "…Cancel and rebook"). When `delta ≤ 0` the existing item loop (free + paid rows) + RPC handle it. Return `refund_owed_cents = max(0, −delta)` in the response so the caller can warn. Keep the `evaluateEditGuard` IDOR/cutoff guard (staff exempt). |
| A4 | Audit | The removed/updated paid line is **already** captured by the smart-diff audit trigger (visible in `<AuditTimeline>`). Add the refund-owed amount to the response for the UI warning. *Open point (§8-c): whether a distinct "refund owed $Z — process manually" audit line is wanted beyond the item-diff.* |

**PR-A does NOT touch Stripe, the webhook, the state machine, or `booking_payment`
writes.** It is the existing engine, exposed inline, with the guard loosened from
absolute-price to delta.

---

## 5. PR-B — the increase payment path (`delta_cents > 0`)

Money-critical. **Release-gated on its own; separate money testing.** Design goal:
charge exactly the delta, keep the booking safe (never expose a previously-valid
booking to the expiry-cancel cron), and apply the added paid item **only** once the
delta settles.

### Why a naive approach is unsafe
- **Full re-charge** (`create-checkout` as-is) charges `new_total`, double-charging
  the already-settled `already_paid` (row 7). ✗
- **`Confirmed → Pending Payment` round-trip** exposes the booking to
  `handle-expired-payments` (which cancels stale Pending Payment bookings) — on
  abandonment it would **cancel a previously-valid booking** (a free Confirmed one
  in row 6, or a paid one in row 7). ✗

### Proposed design (money-safe)
1. **Do not mutate the booking up-front.** Booking stays Confirmed; items unchanged.
2. Persist the **intended new item-set** so the webhook can apply it on success —
   via a new **`booking_edit_intent`** row (keyed to the Stripe session), NOT
   Stripe metadata (session metadata is 500-char/value, fragile for multi-item
   carts). *(§8-a: confirm table vs metadata.)*
3. Create a **delta checkout**: a Stripe Checkout Session for `delta_cents` +ins a
   `booking_payment(pending)` row. Reuse `create-checkout`'s shape via a new
   `mode`/EF (`create-edit-checkout`) so the existing Pending-Payment checkout is
   untouched.
4. **Webhook applies the edit on success:** extend `reconcileCheckoutSession` — when
   the completed session has a `booking_edit_intent`, run
   `update_booking_items_in_place` with the intended items (capacity re-checked
   under the advisory lock), mark `booking_payment` paid, delete the intent. Booking
   was already Confirmed → stays Confirmed.
5. **Abandonment = no change.** No intent applied, booking untouched, `booking_payment`
   expires via the existing cron. Zero risk to the original booking.

### PR-B change surface (indicative — finalised after eng-review)
- Migration: `booking_edit_intent` table (+ RLS, + audit trigger) — stores
  `booking_id`, `stripe_session_id`, `items jsonb`, `collection_date_id`,
  `location`, `notes`, `created_at`.
- New EF `create-edit-checkout` (delta charge + intent row).
- `_shared/checkout-reconcile.ts` — apply-intent branch (idempotent; advisory-lock
  capacity re-check can still fail → surface, don't silently drop).
- `create-booking` `replaces` branch — for `delta > 0`, return a signal telling the
  client to route to the edit-checkout instead of a 400.
- Client — on preview `delta > 0`, "Proceed to payment ($delta)" → edit-checkout →
  Stripe → back to detail page.
- **Capacity-at-payment-time edge:** the added unit isn't reserved during the
  checkout window; if the date fills before payment, the webhook's RPC capacity
  check fails. Decide: fail the application (refund the delta) vs. soft-hold. *(§8-b.)*

---

## 6. Cross-cutting rules

- **Same date always.** `collection_date_id` is read from the booking and passed
  through unchanged. No date picker in this editor. (The separate held-date-drop
  bug is explicitly OUT OF SCOPE — #378-adjacent.)
- **MUD excluded** (row 8) — mirror the existing `editServicesUrl` exclusion:
  double-spend risk against the per-FY MUD cap; MUD edits stay "cancel & rebook".
- **Swap preserved** (row 9) — the EF already upserts/deletes `allocation_swap` on
  edit; the editor passes `swap` through unchanged and must not double-count.
- **Role/status gate** = `canEditCollectionDetails` everywhere (client affordance +
  server action + EF guard) so they can't drift.
- **Red Lines honoured:** no client price trust; no hand-rolled `booking_item`
  UPDATE; no bespoke refund/pricing/capacity logic — the engine + RPC own it.

---

## 7. Testing (TDD — failing tests first)

| Level | Test | PR |
|---|---|---|
| Unit (EF guard) | `delta = total − already_paid`: reject iff `delta > 0`; allow `delta ≤ 0` incl. paid→free and paid→smaller-paid; `refund_owed = max(0,−delta)`. | A |
| Unit (pricing) | Engine recompute honours category cap + service cap + active swap, excludes the edited booking from FY usage (matches services-step + confirm). | A |
| Component | Quantity editor: gate by `canEditCollectionDetails`; hidden for MUD; preview matches server (free/paid split); `delta>0` blocks in PR-A; refund-owed warning shows for rows 3–4. | A |
| Integration (RPC) | Reduce 3→1 keeps the **same date**; paid line deleted / paid `no_services` lowered; capacity counters freed; audit diff shows only real changes. | A |
| Integration (RPC) | Increase within free allocation: same date, capacity re-checked, no money. | A |
| E2E | Admin reduces a bulk booking 3→1 on the detail page → date unchanged, quantities updated, refund-owed warning shown, audit correct (the #380 acceptance flow). | A |
| Unit (delta charge) | `delta_cents` = `new_total − already_paid` (rows 6 & 7); never full `new_total` when `already_paid>0`. | B |
| Integration (webhook) | Intent applied on success (item added, same date, capacity re-checked); **abandonment leaves booking untouched**; double-webhook is idempotent. | B |
| E2E | Free Confirmed booking → increase into paid → Stripe test-card → item added on the same date, booking stays Confirmed, `booking_payment` paid. | B |
| RLS | `booking_edit_intent` scoped correctly; residents can't read others'. | B |

Coverage: pricing engine + state-machine paths stay at 100% (CLAUDE.md §14).

---

## 8. Open decisions — SIGN-OFF NEEDED before PR-B build (money)

- **(a) Pending-edit storage:** new `booking_edit_intent` table (recommended,
  robust) vs. Stripe session metadata (no migration, but fragile/size-limited).
- **(b) Capacity-at-payment-time:** if the date fills during the checkout window,
  the webhook's capacity re-check fails — **refund the delta and reject** (safe,
  recommended) vs. soft-hold the unit during checkout (complex).
- **(c) Refund-owed audit (PR-A):** is the existing item-diff audit line enough, or
  do you want a distinct "refund $Z owed — process manually" audit entry?
- **(d) Non-card / already-open-session (row 5):** reducing a `Pending Payment`
  booking with an open Stripe session — expire + re-issue the session vs. block the
  edit until the pending session resolves.

---

## 9. Rollout / PR sequencing (within expanded #380)

1. **PR-A → `develop`:** editor + `delta ≤ 0` paths + EF guard loosening + manual-
   refund warning. No Stripe/webhook/state-machine/migration. Ships in the next
   `develop → main` batch. Delivers the #380 acceptance flow (reduce 3→1, same date).
2. **PR-B → `develop`:** the delta payment path (migration + new EF + webhook +
   client). **Release-gated**, separate money testing (Stripe test-cards, webhook
   idempotency). The Types-Freshness split rule applies (migration PR → release →
   consumer PR) — see CLAUDE.md §"Migrations + deploy".

Both PRs target `develop`, reference #380 + BR-0028, and spell out the
refund/payment/capacity behaviour for human review.

---

## 10. Stress-test log

- **2026-07-11 — adversarial money-safety review (subagent).** Verdict: v1 §3 delta
  model had a **load-bearing hole**. Findings + resolutions in §11. §3 rewritten to
  v2 (re-price delta + drift hard-block). Two of Dan's earlier decisions are
  affected (#3 manual-refund leak; drift now routes some edits to cancel & rebook) →
  re-surfaced for sign-off before code.

---

## 11. Stress-test findings + resolutions

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | **Critical** | `already_paid = SUM(paid booking_payment)` is a frozen historical charge; vs. a re-priced `new_total` it can turn a reduction into a charge (interim 2nd booking shifts the free tier). | **§3 v2:** `delta = price(new) − price(current)` under one engine call; **hard-block on drift** (`baseline ≠ collected`). |
| 2 | High | `Pending Payment` bookings have `collected = 0`, so any still-paid reduction reads as `delta > 0` (blocked/charged), not row 5's free update. Open Stripe session also desyncs. | Pending Payment does **not** use the delta path: **expire the open session + re-issue for `new_total`** (or cancel & rebook). Baseline = outstanding session amount, not 0. |
| 3 | High | Q1 "manual refund, don't touch `booking_payment`" → a later increase computes delta against an inflated baseline → resident gets a paid unit free (revenue leak). | **DECISION NEEDED (§11a).** Recommend reductions **auto-refund via the existing `refund_request` + `process-refund` machinery** (the cancel flow already does this — reuse, not new logic) so the ledger stays true and `baseline = price(current items)` is trustworthy. |
| 4 | High | PR-B's 2nd `paid` `booking_payment` row breaks `process-refund` (`.single()`) and `cancelBooking` (refunds full total vs one charge) → later cancellations silently fail to refund. `booking_payment` has no unique on `booking_id`. | PR-B must make the refund path **multi-charge-aware**: iterate all `paid` rows, refund each capped at its own `amount_cents`; reconcile `cancelBooking` against the sum. Integration test: increase-then-cancel refunds the full amount across both charges. |
| 5 | Med-High | `extra_unit_price` drift: RPC essence match on `unit_price_cents` → old paid line DELETE+INSERT at the new price; `|delta|` computed at the wrong price. | Covered by the §3 **drift hard-block** (baseline ≠ collected ⇒ block). Where an edit is allowed, price surviving/removed paid units at the **originally-charged** `unit_price_cents` from the existing rows. |
| 6 | High | PR-B webhook: RPC capacity `RAISE` → webhook 500 → Stripe retries forever; delta captured, item never applied, no refund. | Apply-intent branch **catches** the capacity failure, marks intent failed, **auto-refunds the delta**, returns **200**. `paid`-mark + apply + intent-delete must be one transaction / idempotent-in-order. |
| 7 | Med-High | Inline editor that omits `swap` → EF **deletes `allocation_swap`** + re-prices without the conversion → misprice + permanent swap forfeit. | Server action (A2) **loads the booking's `allocation_swap`** (by `property_id, fy_id`) and re-sends `swap`/`swapRuleId` faithfully. Test: editing a swapped booking preserves the swap row + conversion pricing. |
| 8 | Med | No dedup on edit-intent/checkout → retry/double-click double-charges. | Partial unique index: ≤1 open `booking_edit_intent` per `booking_id`; second call **reuses** the open session (mirror `create-checkout`'s reuse path). |
| 9 | Low-Med | Abandoned pending `booking_payment`/intent on a **Confirmed** booking are never GC'd (`handle-expired-payments` only scans Pending Payment). | `create-edit-checkout` sweeps stale pending edit rows for the booking before minting a new one; dedicated cleanup keyed on intent age. |

**Confirmed non-issues (but load-bearing):** the expiry cron only cancels
`Pending Payment` bookings — a PR-B edit keeps the booking **Confirmed**, so it is
never mis-cancelled (add an explicit test asserting Confirmed throughout the
checkout window; any impl that flips Confirmed → Pending Payment reintroduces the
bug). Free/paid split changes are a **zero** capacity delta (split only affects
money, not capacity). Double-webhook is idempotent **iff** apply-intent treats
"no intent" as an applied no-op.

### §11a — money decision re-surfaced (was Q1)

The stress-test shows "reduce → warn → refund **manually**, don't touch the ledger"
is not money-safe: it leaks revenue on a later increase (#3) and fights the drift
guard (a manually-reduced booking would read as drifted and block all future
edits). Cleanest fix: reductions that owe a refund go through the **existing**
refund machinery (`refund_request` Pending → `process-refund`), exactly as
`cancelBooking` does — this keeps `collected_cents` honest and `baseline = price(current)`
trustworthy. This **reuses** the existing engine (not new refund logic), so it also
sits inside the issue's hard constraint. → Sign-off in §8.
