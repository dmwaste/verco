# 0043 — The property register is not public; the booking page looks up one address at a time

- **Date:** 29/10/2026
- **Status:** Accepted

## Decision

The eligible-property register (every address a council collects from, with its notes and MUD details) can no longer be read by someone who isn't signed in, or by a resident.

- **Booking page:** it asks the database one narrow question: "which property is at this address?" The answer is at most 5 matches, and only the columns the page shows.
- **Residents:** they see only the properties on their own bookings.
- **Staff, crews and rangers:** they see their own councils' properties, as before.

The change ships in three steps, one per release, so the booking page never breaks while a release rolls out:

1. Add the lookup.
2. Switch the booking page and the pricing and booking functions to it.
3. Close the register.

## Why

A security review on 29/10/2026 found that anyone with the public website key could page through the whole register without signing in. The key is in every visitor's browser. That was about 110,000 properties across both clients, including:

- free-text location notes, some containing an email address or a gate code;
- the storage paths of MUD authorisation forms;
- strata contact links.

Signed-in residents could do the same. There is no evidence anyone did. But the booking page never needed more than five rows at a time, so the access was all risk and no use.

## What this changed from the original plan

The original design listed the property register as a "public read" table, so the booking page could look addresses up before a resident signs in. The page keeps that ability, now through the narrow lookup instead of the whole table. Two functions also read the property before sign-in: price calculation and booking creation. They use a matching one-property lookup.
