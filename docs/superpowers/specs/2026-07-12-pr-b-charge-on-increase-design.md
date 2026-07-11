# PR-B — charge-on-increase for the inline quantity editor (#380 / BR-0028)

**Date:** 2026-07-12
**Status:** Draft — **product money decisions OPEN (§3), awaiting sign-off before any Stripe build**
**Type:** Feature (money-critical)
**Parent:** #380 / BR-0028. Follows **PR-A ([#384](https://github.com/dmwaste/verco/pull/384), merged)**.
**Source:** `2026-07-11-inline-quantity-editor-design.md` §5 + §11.

---

## 1. Goal

PR-A ships reductions + free-quota changes inline (same collection date) and
**blocks** any edit that increases what's owed (`delta_cents > 0`). PR-B replaces
that block: when a quantity edit increases the amount owed, **charge exactly the
delta via Stripe** and apply the added paid item **only once the delta settles** —
without ever exposing a previously-valid booking to cancellation or double-charging
the already-settled amount.

Delta is PR-A's drift-immune re-price:
`delta = calculatePrice(new, exclude self) − calculatePrice(current, exclude self)`,
and must stay consistent with PR-A's **`collected = SUM(paid booking_payment) −
SUM(approved refund_request)`** netting (§4).

---

## 2. Money-safe mechanics — v2 (HARDENED after adversarial review, §8)

> v1 assumed "booking stays Confirmed" defended everything; it only defends against
> the expiry cron. The review found the real risk is **concurrency during the ~30-min
> payment window** (staff cancel / NCN-NP refund / FY drift / dispatch) plus a
> **multi-charge refund blast radius** far bigger than §11 #4. v2 closes all eight
> must-fixes (§8). The invariants:

1. **Never mutate the booking up-front.** Stays `Confirmed`; items unchanged until
   settle. (The `Confirmed → Pending Payment` round-trip stays banned.)
2. **Charge only the delta**, never the full new total.
3. **Intent stores RAW `{service_id, qty}` + `swap` — NOT a frozen priced item-set.**
   `booking_edit_intent(booking_id, stripe_session_id, items jsonb {service_id,qty},
   collection_date_id, swap, status, applied_at, created_at)`. Re-pricing happens at
   apply time (see 5) so the applied set always agrees with the CURRENT ledger.
4. **Atomic create.** `create-edit-checkout` inserts the `booking_payment(pending)`
   **and** the intent in ONE transaction/RPC. This is what makes the webhook's
   "no intent ⇒ already applied" branch provably safe (§8 C3) — a "paid delta row
   with no intent" can then only mean "applied", never "phantom".
5. **Webhook apply = re-validate + re-price, in a pinned idempotent order** (§8 H3):
   look up `booking_payment` by session; **if an intent exists**, in ONE transaction:
   (a) re-assert `status='Confirmed'` AND **no `collection_stop` rows** AND not past
   cutoff (§8 H1); (b) **re-run `calculatePrice` + `evaluateQuantityEdit`** on the raw
   intent qty (§8 H2); (c) if it re-prices to `apply` with `repriced_delta ≤ charged`
   → `update_booking_items_in_place` (self-idempotent smart-diff) → mark payment
   `paid` → mark intent `applied`, and if `repriced_delta < charged` refund the
   difference on the delta charge; (d) if it re-prices to `block_drift` / a higher
   delta / fails (a)/(b) → **do not apply**; auto-refund the WHOLE delta on the delta
   `stripe_charge_id` directly, mark payment `refunded` + intent `failed`; (e) return
   **200** on every path. **If NO intent** and the delta payment is already paid on a
   Confirmed booking → no-op redelivery (safe because of 4).
6. **Direct, idempotent auto-refund** (§8 C5): the capacity/status/price-fail refund
   calls `stripe.refunds.create({ charge: deltaPayment.stripe_charge_id, amount })`
   guarded on `status != 'refunded'` — **never** through `process-refund`'s `.single()`
   path (which is broken by 2 paid rows).
7. **Void open intents on ANY status/money change** (§8 C1/C2): `cancelBooking`,
   NCN/NP resolutions, and the §3c admin "void" all must `stripe.checkout.sessions
   .expire()` + mark payment `expired` + mark intent `voided`. A voided/expired
   session that a resident still pays lands on the "no intent" branch **and** the
   payment row is already `expired` → auto-refund + alert, never a silent settle.
8. **Multi-charge refund across ALL sites** (§8 C4/M1/M4): after a settled increase a
   booking has ≥2 `paid` `booking_payment` rows. Every refund path — `process-refund`
   (drop `.single()` → charge-targeted / iterate), `cancelBooking`,
   `updateBookingQuantities`, `non-conformance/[id]`, `nothing-presented/[id]`, the
   manual Refunds page, and the `charge.refunded` webhook (`.maybeSingle()`) — must be
   multi-charge-aware and compute the refund amount from **`collected = SUM(paid) −
   SUM(approved)`**, never from `booking_item` prices. **This is a prerequisite that
   also fixes a currently-dormant bug** (any 2-paid-row booking breaks cancel today).
9. **Dedup predicate ≡ GC** (§8 M2): "open" = `status='pending' AND applied_at IS
   NULL`; a partial unique index on `booking_id` over that predicate enforces ≤1 open
   intent (race-safe). `failed`/`voided`/`applied` drop out immediately so the admin
   can re-edit. GC deletes the intent **and** expires the paired payment **and** the
   Stripe session, by intent age.
10. **`collected` consistency (§4):** once the delta settles, the new paid row makes
    `collected` rise by exactly the delta, so the PR-A drift guard + later reductions
    stay correct (verified non-issue for the net-delta model, §8).

---

## 3. PRODUCT MONEY DECISIONS — RESOLVED (Dan, 2026-07-12)

| # | Decision | Chosen |
|---|---|---|
| 3a | Surface & payer | **B — Admin-relayed link, resident pays now.** Admin increases → gets a Stripe checkout URL/QR to relay to the resident → resident pays on the Stripe-hosted page (~30-min window). Admin never touches the card. No new notification template, no bespoke resident pay page. |
| 3b | Capacity during checkout | **First-to-pay-wins + auto-refund** (my recommendation, adopted). Because 3a-B is synchronous (~30-min window), the "slot fills mid-payment" race is tiny; the soft-hold subsystem isn't worth it. If the date filled at apply-time, the webhook auto-refunds the delta + surfaces it. |
| 3c | Link window / second edit | **~30 min** session (mirrors `create-checkout`). While an intent is open, a second inline edit is **blocked** ("a change is awaiting payment — void it first"); the admin can **void** the open intent (cancels the Stripe session + deletes the intent) to make another change. Dedup index enforces ≤1 open intent. |
| 3d | Mixed-direction edits | **Net a single delta.** An edit may change several services; `delta = new_total − collected` drives ONE charge (net > 0) or ONE refund (net ≤ 0, the PR-A path). The intent holds the **full** new item-set; the whole set applies atomically on settle. |

Implications of 3a-B (vs the bigger option A): **no** notification template, **no**
resident-facing pay page, **no** long link window — the admin relays a short-lived
Stripe link. Smaller build than A; the pending-state admin UI + void action are the
only new front-end surface.

### 3a details (superseded — kept for the record)
The inline editor is **admin-facing**; the money is owed by the **resident**, who is
not present and whose card the admin must never enter. So "Proceed to payment"
cannot mean the admin pays. Options:

| Option | Flow | Cost / notes |
|---|---|---|
| **A. Async payment request (admin editor)** | Admin increases → intent + Stripe link created → resident **notified (email/SMS)** → resident pays on the Stripe-hosted page → item applied on webhook. Admin sees "payment requested / pending". | Biggest build: notification template + a longer link-validity window + a pending-state UI. Handles the not-present resident. Matches "admin editor charges *instead of blocking*". |
| **B. Admin-relayed link (synchronous)** | Admin increases → gets a checkout URL/QR to relay to the resident (phone/counter) → resident pays on the Stripe-hosted page now. | Medium: no new notification/resident page; ~30-min link window; needs the resident reachable at that moment. Admin never touches the card. |
| **C. Resident self-service only** | Paid increases move to the **resident booking-edit wizard** (resident pays for their own increase, like a new booking); the **admin editor keeps blocking** increases. | Smallest money build — reuses the existing `create-checkout` Pending-Payment flow for the resident's own edit. But it's a *different surface* than PR-A, and doesn't let admins add paid extras. |
| **D. Both A + C** | Admins request-to-pay (A) **and** residents self-serve (C). | Largest scope. |

**My read:** the PR-A editor is admin-only and BR-0028 is an admin workflow, so a
pure resident-wizard build (C) doesn't serve the reported need; but A is a
materially bigger money surface (notifications + resident payment page + pending
state). This is Dan's call.

### 3b — Capacity during the checkout window
The added unit is **not reserved** while the resident pays. If the date fills first,
the webhook's capacity re-check fails. Two behaviours:

- **First-to-pay-wins + auto-refund** (§2 #6): don't hold; if the slot's gone at
  payment, auto-refund the delta and notify. Simple, but a customer can be *charged
  then refunded* — a real (if rare) money event.
- **Soft-hold the unit** during the checkout window (e.g. a short-lived reservation
  on `collection_date`/pool counters that expires on abandonment). No charge-then-
  refund, but adds reservation bookkeeping + its own expiry/GC.

### 3c — Abandonment & link-validity window
- How long is the payment link/intent valid (A: 24–48h? B: ~30 min)?
- While an intent is open, is a second inline edit **blocked** ("a change is awaiting
  payment") or allowed (superseding the open intent + voiding its session)?
- Does the resident get any comms on abandonment (A only)?

### 3d — Mixed-direction edits (partial-apply)
Can a single inline edit both **reduce** service X (refund) and **increase** service
Y (charge)? Options: (i) net it to a single `delta` (charge if >0, refund if <0,
apply the whole set atomically on settle); (ii) restrict an edit to one direction
(simpler, avoids a charge+refund in one action). Affects the delta contract.

---

## 4. Consistency with PR-A (must not diverge)
- `delta`, drift guard, and `collected = paid − approved refunds` are **shared** with
  PR-A. PR-B adds a new paid `booking_payment` on settle → `collected` rises by the
  delta → the PR-A drift guard and any later reduction remain correct.
- The `inline_edit` gating and `canEditCollectionDetails` role/status gate carry over.
- MUD/ID stay excluded; swap is re-sent and reconciled by the existing EF logic.

---

## 5. Change surface (indicative — finalised after eng-review + §3 answers)
- **Migration:** `booking_edit_intent` (+ RLS, + audit trigger, + partial unique
  index on `booking_id` for open intents). Types regen (split-PR per the
  types-freshness rule).
- **EF `create-edit-checkout`:** compute delta server-side (never trust client),
  create the Stripe session for the delta, insert `booking_payment(pending)` + the
  intent. Dedup open intents (§2 #8).
- **`_shared/checkout-reconcile.ts`:** apply-intent branch — idempotent; capacity-fail
  → auto-refund + 200 (§2 #6).
- **`process-refund` + `cancelBooking`:** multi-charge-aware (§2 #4).
- **`create-booking` `replaces` branch:** for `delta > 0` under `inline_edit`, return
  a "requires payment" signal (with the delta) instead of the PR-A block.
- **Client (per §3a):** admin editor "Request payment ($delta)" (A/B) and/or resident
  wizard "Proceed to payment" (C); pending-state UI (A).
- **GC cron** for abandoned intents (§2 #9); **notification template** (A only).

---

## 6. Testing (TDD — money-critical, adversarial)
- Delta charge = `new − collected` (never full total); pure + integration.
- Webhook: apply-on-success (item added, same date, capacity re-checked); **abandon
  → booking untouched, stays Confirmed**; **double-webhook idempotent**; **capacity-
  fail → auto-refund + 200, no phantom item**.
- Dedup: retry/double-submit reuses the open session (no double-charge).
- **Multi-charge refund regression:** increase-then-cancel refunds the full amount
  across both charges; a pre-existing single-charge cancel still works.
- Consistency: after a settled increase, `collected` reflects it; a subsequent PR-A
  reduction re-prices + refunds correctly (no drift).
- Stripe test-cards E2E (as far as the harness allows; the EF is mocked in E2E, so
  webhook/apply logic is unit/integration-tested via extracted pure functions).
- Own release gate.

---

## 7. Plan
1. **This step:** spec + surface §3 decisions to Dan (done — reporting back).
2. On answers: `/plan-eng-review` + `/grilling` (money), then adversarial review of
   the charge path.
3. `/executing-plans` on `feature/380-pr-b-charge-on-increase` (off develop), TDD.
4. `/verify` → review rail → `/ship` PR → **develop** (never main), ref #380 + BR-0028.

---

## 8. Adversarial review findings + resolutions (2026-07-12)

Verdict: v1 §2/§3 **not money-safe to build as written**. All folded into §2 v2.

| # | Sev | Finding | Resolution (§2 v2) |
|---|---|---|---|
| C1 | **Crit** | Staff **cancel** mid-window → resident pays live link → RPC (no status guard) resurrects items on a **Cancelled** booking, no refund. | §2 #7 void-on-status-change + §2 #5(a) re-assert Confirmed at apply. |
| C2 | **Crit** | **Void** deletes intent but leaves the Stripe session payable → phantom charge for a discarded change. | §2 #7 void = expire session FIRST + expire payment + mark intent voided. |
| C3 | **Crit** | Non-atomic payment+intent insert → "no intent = no-op" webhook branch silently settles a phantom charge. | §2 #4 atomic create in one txn/RPC. |
| C4 | **Crit** | `process-refund` `.single()` breaks for **every** refund once 2 paid rows exist — cancel/reduction/NCN/NP/manual + `charge.refunded`. Amount also wrongly from `booking_item`. | §2 #8 multi-charge across ALL sites, amount from `collected`. |
| C5 | **Crit** | Capacity-fail auto-refund via `.single()` → 500 → Stripe retries forever w/ money captured; or double-refund on redelivery. | §2 #6 direct charge refund, idempotent, terminal marks. |
| H1 | High | Window straddles Confirmed→Scheduled cron / T-3 stops / Completed → paid item added to a **dispatched** booking, OR-desync. | §2 #5(a) re-assert Confirmed + no `collection_stop` + not past cutoff. |
| H2 | High | Frozen priced item-set + FY drift mid-window → **overcharge** + permanent **drift-lock** of the booking. | §2 #3 raw-qty intent + §2 #5(b) re-price at apply, reconcile vs charged. |
| H3 | High | Webhook idempotent order/branch-key undefined; base reconcile marks paid unconditionally. | §2 #5 pinned order (apply→mark-paid; branch on intent; self-idempotent RPC). |
| H4 | High | Approved NCN/NP refund mid-window desyncs the frozen set from `collected`. | §2 #5(b) re-price at apply reconciles to current `collected`; §2 #7 void on NCN/NP. |
| M1 | Med | `updateBookingQuantities` is a 3rd `.single()` site; partial-refund allocation across 2 charges undefined. | Folded into §2 #8 (allocation: newest charge first, capped). |
| M2 | Med | Dedup predicate vs GC mismatch → a failed intent locks all edits until GC. | §2 #9 "open" = pending AND applied_at IS NULL; GC drops the rest + cleans. |
| M3 | Med | `create-edit-checkout` must recompute delta + item-set server-side (Red Line #1). | §2 #4 + §5; hard test that a tampered client delta is ignored. |
| M4 | Med | `charge.refunded` webhook `.maybeSingle()` breaks with 2 pending refund_requests. | §2 #8 key the lookup on the charge, not the booking. |
| M5 | Low | Receipt page `.limit(1)` shows one of two charges. | Minor UI: show all paid rows on the booking receipt panel. |
| M6 | **Product** | Delta settles on a Confirmed booking → `didTransition=false` → **no Verco confirmation**; 3a-B has no notification. A paid item silently appearing is a support-ticket risk. | **NEEDS DAN — §9.** |

**Verified non-issues:** stays-Confirmed vs expiry cron (cron is Pending-Payment-only);
net-delta mixed edit (netting correct by construction, freed value absorbed not
double-counted); net-zero paid-unit reallocation (PR-A apply path, capacity re-checked).

---

## 9. Post-review decisions — RESOLVED (Dan, 2026-07-12)

- **Split: YES.** Ship **PR-B0** first (multi-charge-aware refunds across all 5 sites
  + `charge.refunded` webhook; amounts from `collected`; regression-test single-charge
  cancel; no new charge source), release it, then **PR-B1** (`create-edit-checkout` +
  `booking_edit_intent` + webhook-apply) on top. PR-B0 is independently valuable (fixes
  the dormant cancel bug) and cannot double-charge.
- **M6: Stripe receipt + existing audit (no new comms).** No new notification. The
  item-apply already writes an audit entry; add the small **M5** fix so both charges
  show on the booking receipt panel (rides with PR-B1). No resident-facing Verco
  confirmation beyond Stripe's receipt.

### PR-B0 scope (build now)
Make every refund path multi-charge-aware while **preserving single-charge behaviour
exactly** (2-charge bookings are dormant until PR-B1, so this is a safe, tested
refactor):
- `process-refund` — drop `.single()`; refund the request amount across the booking's
  `paid` `booking_payment` rows, newest-charge-first, each capped by that charge's
  Stripe-remaining (`amount − amount_refunded`); record every Stripe refund.
- Callers/sites to audit + fix: `cancelBooking`, `updateBookingQuantities`,
  `non-conformance/[id]/actions.ts`, `nothing-presented/[id]/actions.ts`, the manual
  Refunds page, and the `charge.refunded` webhook (`.maybeSingle()` → charge-keyed).
- Refund amount from `collected = SUM(paid) − SUM(approved refunds)`, never from
  `booking_item` prices.
- Pure, unit-tested allocation helper; integration test single-charge cancel (no
  regression) + a synthetic 2-charge cancel (full refund across both).
