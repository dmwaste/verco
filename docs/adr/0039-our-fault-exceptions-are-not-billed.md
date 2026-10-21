# 0039 — A Nothing Presented or Non-conformance that was D&M's fault is not billed

- **Date:** 21/10/2026
- **Status:** Accepted (amends 0017)

## Decision

A Nothing Presented or a Non-conformance is billable **unless the office has recorded it as D&M's fault** (Dan, 21/10/2026). When staff investigate a disputed notice and tick "contractor fault", that collection drops off the monthly client report that backs the invoice. It also drops off the Bookings-screen totals that councils check the invoice against (ADR 0038).

## Why

ADR 0017 bills these outcomes because D&M turned up. For a Nothing Presented, the resident had put nothing out. For a Non-conformance, they had put out the wrong things. That reasoning only holds when the resident is the cause. When the office finds, on investigating a dispute, that the crew missed waste that was there, closed the job wrongly or refused a pile it should have taken, D&M did not deliver the service, and the council should not pay for our mistake.

The fault is recorded per collection run, meaning one waste stream of one booking (general, green and so on). The rule follows that. If a booking went wrong on its green run by our fault, only its green collection comes off the invoice, and its general collection still bills. A crew mattress count on an our-fault run comes off too. A notice that was rebooked was already off the invoice (Rebooked), and still is; the redo bills as before.

On the day this was decided, the rule moved these units, all bulk or green:

| Month | Council | Units off | Outcome |
|---|---|---|---|
| July 2026 | Verge Valet: Cottesloe 1 bulk, Mosman Park 1 bulk + 2 green | 4 | Nothing Presented |
| August 2026 | Kwinana Area 2 | 2 bulk | Non-conformance |
| September 2026 | Verge Valet: Cottesloe | 1 bulk | Non-conformance |

Nothing else moved. Those months were already invoiced, so the rule applies only from **collection dates on/after 01/10/2026** (pre-release review, 21/10/2026). Re-downloading July–September still gives the invoiced numbers, so a council reconciling an issued invoice sees no difference. Whether to credit those 7 units anyway is Dan's call.

## What this changed from the original plan

ADR 0017 billed every Nothing Presented and Non-conformance. It now bills them except the ones the office has recorded as D&M's fault. The rule lives in two places, the invoice report (`get_client_monthly_report`) and the Bookings-screen totals (`get_booking_tally`), and a test fails if they ever disagree. The Bookings screen lists our-fault outcomes on their own lines ("… — D&M's fault, not billed"), so the totals still add up. The DM-Ops collections feed (`dmops_export.collection_daily_v1`) still counts these units, as attended collections, which they were.
