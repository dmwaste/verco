# 0013 — Properties are corrected in place, never "mark ineligible and recreate"

- **Date:** 22/08/2026
- **Status:** Accepted

## Decision

Admins edit an eligible property's address in place; the system re-geocodes it automatically. Moving a property to a different collection area is a D&M-only action and is refused while the property has any booking that hasn't finished (pending payment, submitted, confirmed or scheduled).

## Why

Until now the only way to fix a typo in an address was to mark the property ineligible and create a new one (BR-0034; about one a week). That left the resident's bookings, allocation adjustments and green-waste swaps stuck on the abandoned row — and handed the new row a **fresh full year's allocation**, so a household that had already used its collections could book them again for free. Editing in place keeps history attached to the same property.

Area moves are restricted because a booking's collection date and capacity count belong to the area it was booked in; moving the property underneath a live booking would strand it. Once the bookings are finished the move is safe, and it is a contractor decision (same precedent as D&M-only date overrides).

## What this changed from the original plan

Issue #502 left the editable field set open. Settled: `address` only (derived geocode fields are regenerated, not edited); area as a separate gated action; eligibility and MUD flags stay on their existing toggles.
