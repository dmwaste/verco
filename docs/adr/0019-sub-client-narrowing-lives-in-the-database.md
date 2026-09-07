# 0019 — Council-scoped staff are narrowed by the database, not by each page

- **Date:** 01/09/2026
- **Status:** Accepted

## Decision

When a council staff login is restricted to one member council (a "sub-client" — e.g. a Mosman Park user under Verge Valet), the database itself now hides other councils' properties, collection areas, collection dates and allocation/service rules from them. Previously only bookings and their follow-on records (notices, tickets, surveys) were narrowed this way; the reference tables relied on each admin page remembering to filter, and none of them filtered past the client level.

## Why

On 1 September, Mosman Park staff reported they could see all Verge Valet data. Verified in production: a MOS-scoped login saw only Mosman Park's 428 bookings (that part worked), but also all 90,919 properties, all 585 collection dates and all 12 areas across the ten WMRC member councils — on the Properties and Collection Dates pages and in every area dropdown. Resident addresses belonging to nine other councils were visible to a user deliberately restricted to one. That's a tenant-isolation promise to WMRC broken, and the kind of thing that erodes council trust in the platform.

The original May design (VER-216) knew these tables couldn't be narrowed by the database — they must stay publicly readable so residents can book without logging in — and said each admin page should filter instead. That filtering was never built past the client level, and with ~29 admin files reading these tables, every future page would have had to remember it too.

The fix moves the rule into the database read policies themselves, written so it only bites a restricted user: everyone else — residents booking, unrestricted council admins, D&M staff, crews — sees exactly what they saw before (verified byte-identical in production before shipping). One rule, enforced in one place, covering every current and future screen.

## What this changed from the original plan

VER-216 said "app-layer scoping is the right defence" for the publicly readable tables. That's reversed: the defence is in the database policies, using a condition that defaults open for everyone without a sub-client restriction, so the public booking flow is untouched. Known edge case, accepted: a council staff member who logs into the resident booking site with the same email as their staff account will have their home-address lookup narrowed to their own council's area.
