# 0001 — Refund approval happens in Verco, not DM-Ops

- **Date:** 12/07/2026
- **Status:** Accepted

## Decision

Refunds are reviewed and approved by a Verco admin (a `contractor-admin` or `client-admin`) on the admin Refunds page. DM-Ops plays no part in the refund flow.

## Why

The people best placed to judge a refund are the ones who can already see the booking, the payment, and the resident's history — and that's all in Verco. Routing each refund out to a second system (DM-Ops) would add a hand-off with no extra safety: the same D&M staff would be approving it either way, just in a different app, without the booking context in front of them.

## What this changed from the original plan

The original spec (PRD §5.4) said "DM-Ops staff review and approve". Dan accepted the change; the spec now reads Verco-internal — "Not a DM-Ops action" (PRD §13.5). In practice the Refunds page has lived in Verco since it was first built (March 2026); the spec was reconciled to match on 12/07/2026.
