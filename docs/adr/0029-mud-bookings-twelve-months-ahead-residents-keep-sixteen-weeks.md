# 0029 — Staff can book MUD collections 12 months ahead; residents keep 16 weeks

- **Date:** 13/10/2026
- **Status:** Accepted

## Decision

The collection calendar runs on a **rolling 12 months** (the date generator builds about 56 weeks ahead instead of 16), so staff can schedule a MUD's collections a year out from its MUD booking page.

**Residents keep the 16 weeks they always had.** This includes staff booking on a resident's behalf through the booking wizard. The date picker shows only the next 16 weeks, and the server refuses anything later. MUD bookings, made on their own page, are not capped.

In council areas where every collection day is already a MUD day, the calendar now marks MUD days by itself. The rule is per area and per weekday (`collection_schedule.mud_weeks`: which occurrences in the month; first to fifth). Vincent and Kwinana keep their hand-picked MUD days, because their cadences are deliberate. Pooled councils need no marking: MUDs book any open day.

A booking's **financial year is the year its collection date falls in**, not the year it was booked in. A MUD booked now for August 2027 counts against FY28's allowance. FY28 now exists, and the 2027 WA public holidays are complete from the official list.

## Why

WMRC (Jared Crowe, 12/10/2026) asked to schedule MUD collections up to 12 months ahead, as the old system allowed. The MUD booking page already accepted dates a year out, but there was nothing to pick from:
- the calendar stopped about 16 weeks ahead;
- MUD days were ticked by hand as dates appeared;
- with no FY28, a booking for July 2027 or later would have been filed under FY27.

Residents stay at 16 weeks for two reasons. A year-long booking window wasn't asked for and would change what residents see. And the resident pricing path still prices against the current financial year (see below).

## What this changed from the original plan

The calendar horizon was a fixed 16 weeks for everyone. Staff and residents now have different horizons.

**Still open (issue #644):** the resident booking path and its price preview use the *current* FY. That's safe while residents are capped at 16 weeks, until about 10 March 2027, when 16 weeks ahead first crosses 30 June. It must be fixed before then. The 1 July rollover (`financial_year.is_current`) is also still a manual flip.

**Not yet done:** booking a MUD's whole year in one go (Option 2). That's planned for November, once WMRC agrees the rules for dates, capacity and notifications. 2028 public holidays aren't published yet. The generator never builds past 31 December of the last year whose holiday list reaches December. It reports `holiday_capped` instead, so a holiday can't open as a collection day. From December 2026 the window shrinks gently below 12 months until the 2028 list is loaded.
