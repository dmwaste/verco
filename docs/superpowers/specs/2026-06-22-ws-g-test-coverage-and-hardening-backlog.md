# WS-G — Test Coverage Summary & Hardening Backlog

**Date:** 2026-06-22
**Context:** WMRC asked for a staged rollout because they weren't confident the
system had been "thoroughly tested." WS-G is the end-to-end hardening pass that
(a) inventories what *is* covered — the evidence — and (b) registers the honest
gaps as a prioritised backlog so they're tracked, not hidden.

This is the document to show WMRC: it is candid about what's covered and what
isn't, and every gap has an owner-ready Linear issue.

---

## 1. What IS tested (the evidence)

As of this pass: **719 unit tests across 71 files**, all green, plus a 9-spec
Playwright E2E suite and a 5-table × 5-role RLS smoke suite.

| Area | Tests | Confidence |
|---|---|---|
| **Pricing engine** (dual-limit free units, conversions, swaps, overrides, line-item build) | `pricing.test.ts`, `pricing/{build-breakdown,calculate-with-overrides,conversion,swap}.test.ts` | High — the pure Node core (`calculate.ts`) is exhaustively covered |
| **Booking state machine** | `state-machine.test.ts`, `booking-schedule-transition.test.ts`, `closure-status.test.ts` | High — transition table enforced |
| **NCN/NP state machine** | `mud-state-machine.test.ts` | High (module level) |
| **Cancellation cutoff** (3:30pm AWST day-prior) | `cancellation-cutoff.test.ts` *(NEW this pass)* | High — TZ-independent, matches DB trigger |
| **MUD / strata** (allowance, capacity, lookup, context, provisioning) | `mud-*.test.ts`, `user-strata-provisioning.test.ts` | High |
| **Notifications** (dispatch, health, PII-leak guard, SendGrid events, templates) | `notifications/*.test.ts` | High — incl. an explicit PII-leak regression test |
| **Field stops / OptimoRoute** | `stops.test.ts`, `stop-runs.test.ts`, `field/run-sheet-card-links.test.ts` | High |
| **HubSpot sync** (batch, cursor, mappers, status maps) | `hubspot/*.test.ts` | High |
| **Reports waste-stream weighting** | `waste-stream.test.ts` | High |
| **Proxy / multi-tenant routing** | `proxy-hostnames.test.ts`, `hostnames.test.ts`, `resolve-on-behalf-client.test.ts` | High |
| **Go-live gate** (WS-A) | `area-gate.test.ts` + inactive-area E2E | High |
| **RLS policy stack** (PII red lines, tenant + sub-client scope) | `rls.test.ts` (5 tables × 5 roles, pg-direct + JWT-claim impersonation) | High *locally* — see Gap H1 |

**E2E (Playwright):** `auth`, `booking-flow`, `paid-booking`, `allocation-swap`,
`field-runs`, `illegal-dumping`, `ncn-detail`, `contact-faqs`, `landing`.

**CI:** `ci.yml` runs `pnpm test` (all 719) on every PR. `pnpm test:e2e` runs
only on PRs targeting `main` (i.e. at release time) — by design, but it means
behaviour-level E2E coverage lands at the batch boundary, not per-PR.

---

## 2. The honest gaps (prioritised backlog)

Four genuine P1 gaps. None block the Stage-1 (29 Jun) go-live — the affected
paths are all defended at the DB layer (RLS, triggers, the capacity RPC's
serialisable transaction) which is the real security/correctness contract. The
gap is **automated regression coverage** of those layers, which is exactly the
confidence WMRC is asking for over the rollout window.

### H1 — RLS smoke suite isn't gated in CI
`test:rls` exists and is well-built (5 tables × 5 roles, exercises the full
policy stack as the `authenticated` Postgres role), but `ci.yml` only runs
`pnpm test` + `pnpm test:e2e`. The RLS suite needs `SUPABASE_DB_URL` and runs
against a live DB, so it never gates a PR. **A policy regression — including a
PII red-line break — can ship green today.** This is the single highest-value
gap for the "is the security model tested?" question.
*Fix:* add a CI job that runs `test:rls` against a DB-URL secret (a Supabase
branch or a dedicated test project), skipping gracefully when unset.

### H2 — Payment Edge Functions aren't unit-tested
`create-checkout` (double-charge guard), `stripe-webhook` (HMAC verification +
Pending Payment → Confirmed auto-confirm), and the reconcile path are only
exercised via mocked E2E. Vitest excludes `supabase/functions/`, so the actual
EF decision logic has no unit coverage. This is the money path.
*Fix:* extract the pure decision logic into `_shared` + a Node mirror and
unit-test it — the `expiry-decision.test.ts` pattern already proves this works
for `handle-expired-payments`.

### H3 — Capacity RPC + advisory-lock concurrency untested
`create_booking_with_capacity_check` (both the per-date and pooled/VV branches)
is the oversell guard, wrapping the capacity check + insert in a serialisable
transaction with a Postgres advisory lock. No test exercises the concurrency
behaviour — the one thing the advisory lock exists to guarantee.
*Fix:* a DB-integration harness (pg-direct, same approach as `rls.test.ts`) that
fires concurrent bookings against a near-full date and asserts no oversell.

### H4 — Pricing engine is duplicated across EF + Node with no drift guard
`_shared/pricing.ts` (authoritative, does its own I/O, exports `calculatePrice`)
and `src/lib/pricing/calculate.ts` (pure, 100%-tested, exports
`computeLineItems`) are **separate reimplementations** of the dual-limit /
conversion math — not a mirror pair (different shapes by design), so they're not
in `sync-mirrors.sh` and nothing catches divergence. The tested copy can stay
green while the EF copy — the one that prices real bookings — drifts.
*Fix:* extract the pure dual-limit core into a shared module both consume; the
EF keeps only the I/O shell. Then the existing tests gate the real path.

### Noted, not ticketed
- **Capacity counter excludes `Submitted`** — low impact: `Submitted` is a
  legacy/dead state (bookings auto-confirm). Worth a comment, not a fix.

---

## 3. Shipped this pass
- **Cancellation cutoff TZ fix** (commit `25776ba`, PR #199): the 3:30pm-AWST
  cutoff was computed with `Date#setHours()` in the runtime TZ — correct on a
  dev box (AWST), wrong on the UTC prod container, wrongly blocking valid
  cancellations and showing the wrong deadline. Extracted to a tested
  `cancellationCutoff` helper (07:30 UTC, matches the DB trigger exactly) wired
  into both cancel actions + the booking-detail + dashboard displays.
