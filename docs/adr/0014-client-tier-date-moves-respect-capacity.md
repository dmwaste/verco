# 0014 — Council staff can't move a booking onto a full date; D&M staff still can

- **Date:** 22/08/2026
- **Status:** Accepted

## Decision

When a council (client-tier) admin changes a booking's collection date, the new date must have room for that booking's services. D&M (contractor-tier) staff keep the existing override and can move a booking onto a full, closed or past date as a correction.

## Why

Six Kwinana collection dates went over their bulk limit in July–August. The cause was not a gap in the booking flow — it was admins using the "change date" control to move bookings onto dates that were already full, which was allowed on purpose (ADR-era decision #378: a date change is a correction, not a new booking). That reasoning holds for D&M, who own the crew constraint and can see what a truck can absorb; it doesn't hold for council staff, who can't. Over-booked dates mean longer days or missed collections.

## What this changed from the original plan

The capacity-bypass demand tracker (#426) was counting these moves as "bypass demand". They weren't — so the tracker's build-a-bypass decision rule doesn't apply to them. Enforcement is in three places that can't drift: the date picker (full dates shown but not selectable), the server action, and the database trigger.
