# 0024 — Council staff see only their own council's notifications and tickets, and no audit log until it is tagged by council

- **Date:** 30/09/2026
- **Status:** Accepted

## Decision

Staff scoped to one council (for example a Peppermint Grove officer under Verge Valet) now see only:
- notifications for their own council's bookings;
- service tickets on their own council's bookings. Replies follow their ticket.

General enquiries with no booking aren't linked to any council, so they're hidden from council staff. WMRC and D&M staff still see and handle them. Council staff also see no audit log entries for now; WMRC-wide and D&M staff are unchanged.

Separately, two changes cover more than council staff:
- Client staff (council and whole-client) no longer see residents' account profiles; staff profiles are unchanged.
- Field crews can no longer read the notification log at all.

## Why

The 23/09/2026 privacy review found, and a check on 30/09 confirmed, that a council-scoped officer could read other councils' residents' contact details:
- 8,855 notification records, which include resident emails and mobiles;
- 314 resident account profiles;
- 30 unrelated tickets;
- the whole audit log, which holds before-and-after copies of contact records.

Five more councils' staff get logins from 01/10/2026, so every day this stayed open added another council's residents to what the others could browse.

The same check found that a crew account could read all 26,440 notification records with resident contact details. Crews must never receive resident contact details (Red Line #2).

## What this changed from the original plan

ADR 0019 put council scoping on the core tables (bookings, properties, dates). These side tables were missed. That's fixed here as a freeze hotfix.

Hiding the whole audit log from council staff is a stopgap (Dan, 30/09). It blanks their History panels. The proper fix is to tag each audit entry with its council so they see their own council's history again. That needs a one-off update of about 265,000 rows, which is scheduled for after the freeze (16/10/2026).
