# 0003 — Only admins can approve the actual refund payment

- **Date:** 12/07/2026
- **Status:** Accepted

## Decision

Line staff (`contractor-staff` / `client-staff`) can cancel or reduce a paid booking — which automatically raises a Pending refund — but only a `contractor-admin` or `client-admin` can approve that refund, which is the step that actually sends money back through Stripe.

## Why

It splits "creating the debt" from "paying the debt". A staff member handling a resident on the phone can do the cancellation on the spot; the money movement then sits queued on the Refunds page until an admin signs it off. The check is enforced on the server (the `process-refund` function rejects non-admin callers), not just by hiding buttons — so a staff login can't approve a payment even by calling the system directly. The same function also re-checks that the admin belongs to the right council, and guards against the same refund being approved twice by two people clicking at once.
