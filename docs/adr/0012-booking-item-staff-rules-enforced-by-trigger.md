# 0012 — Council-staff booking-item rules are enforced by a database trigger, not only in app code

- **Date:** 22/08/2026
- **Status:** Accepted

## Decision

The rules that say what a council (client-tier) admin may do to a booking's line items — no price changes, no moving onto a closed or past date, no editing once the crew has been dispatched, never onto another area's date — now live in a `BEFORE UPDATE` trigger on `booking_item` (`enforce_booking_item_staff_write`), mirroring the app-side gate. Price/identity columns are pinned for every user role; the area pin applies to every role too.

## Why

The app already enforced these rules on its own screens, but the database let any council admin with a login write straight to `booking_item` through the API and skip them — change a price to zero, move a booking onto a date the crew has already finalised, or even point an item at a different council's collection date and corrupt that council's capacity counts. A resident's booking and D&M's money were protected only by the UI being the only thing anyone used. Now the database says no regardless of how the write arrives.

## What this changed from the original plan

Issue #383 left open whether to use a row-security policy or a trigger. Trigger won: the rule needs to compare the old and new row, look at the parent booking's status and the target date's open/closed/area flags — doing that inside a row-security policy re-runs those lookups for every row read and is the same pattern that caused admin list timeouts before (#347). The existing field-crew column pin on this table is already a trigger, so one mechanism now covers both.
