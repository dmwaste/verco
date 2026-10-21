# 0039 — A Nothing Presented that was D&M's fault is not billed

- **Date:** 21/10/2026
- **Status:** Accepted (amends 0017)

## Decision

A Nothing Presented is billable **unless the office has recorded it as D&M's fault** (Dan, 21/10/2026). When staff investigate a disputed Nothing Presented and tick "contractor fault", that collection drops off the monthly client report that backs the invoice, and off the Bookings-screen totals that councils check it against (ADR 0038).

## Why

ADR 0017 bills a Nothing Presented because D&M turned up and the resident had put nothing out. That reasoning only holds when the resident is the cause. When the office finds, on investigating a dispute, that the waste *was* there and the crew missed it or closed the job wrongly, D&M did not deliver the service, and the council should not pay for our mistake.

The fault is recorded per collection run, meaning one waste stream of one booking (general, green and so on). The rule follows that. If a booking was marked Nothing Presented on its green run by our fault, only its green collection comes off the invoice, and its general collection still bills. A crew mattress count on an our-fault run comes off too.

On the day this was decided, the rule moved **4 units, all Verge Valet, July 2026**: Cottesloe 1 bulk, Mosman Park 1 bulk and 2 green. August to October were unchanged. A contractor-fault Nothing Presented that was rebooked was already off the invoice (Rebooked), and still is; the redo bills as before.

**Not decided here:** a **Non-conformance** marked as D&M's fault is still billed. Two exist today (one Kwinana in August, one Verge Valet in September). Whether they should follow this rule is a separate call for Dan.

## What this changed from the original plan

ADR 0017 billed every Nothing Presented. It now bills every Nothing Presented except one the office has recorded as D&M's fault. The rule lives in two places, the invoice report (`get_client_monthly_report`) and the Bookings-screen totals (`get_booking_tally`), and a test fails if they ever disagree. The DM-Ops collections feed (`dmops_export.collection_daily_v1`) still counts these 4 units, as attended collections, which they were.
