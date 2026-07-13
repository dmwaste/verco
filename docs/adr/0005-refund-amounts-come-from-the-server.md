# 0005 — Refund amounts shown or emailed always come from our own records, never the request

- **Date:** 12/07/2026
- **Status:** Accepted

## Decision

Any refund figure that appears on a page or in an email/SMS is read from the stored refund record at the moment of use. Nothing sent in from a browser — or from another system calling ours — can supply the amount.

## Why

A caller-supplied figure could be forged: a resident could be emailed "you'll be refunded $500" while the record says $50, and the mismatch would only surface as a complaint. Deriving every displayed amount from the `refund_request` row means the number a resident reads is the number that will actually move — and the payment step itself (ADR 0003) works off the same row, capped against what Stripe says is genuinely refundable on the original charges. This follows the same principle as booking prices, which have always been recomputed server-side and never trusted from the client.
