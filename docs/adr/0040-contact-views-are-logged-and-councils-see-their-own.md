# 0040 — Every view of a resident's contact record is logged, and each council sees the views of its own residents

- **Date:** 21/10/2026
- **Status:** Accepted

## Decision

Each time the caller lookup shows a resident's contact record, Verco records who opened it, when, and on which screen (VER-322). The records can't be edited or deleted from the app. D&M admins can read every record. A council admin can read the records for that council's residents only, including the views made by D&M staff. Recording a view never stops the page from showing: if the record can't be written within 2 seconds, the page still opens and the failure goes to Sentry. The same staff member re-opening the same resident on the same screen within 5 minutes (a refresh, or the council switch behind "Add a note") counts as one view, so the log doesn't overstate how often a record was opened.

## Why

Since the Teams call pop went live (VER-316), every answered call opens a resident's name, phone, email, bookings and tickets. Nothing recorded those reads. That is gap 7 in the 23/09/2026 privacy review against the PRIS principles: we couldn't answer "who has looked at this resident's details?" if a resident or a council asked.

The record belongs to the resident's council, not to the staff member's employer. Councils hold their residents' information and D&M handles it for them, so a council needs to see D&M's access to its residents, not just its own officers'. A council officer limited to one council under Verge Valet sees only that council's residents. Crews, rangers and residents can't read the records at all.

A failed write doesn't block the page, because the page is open while a resident is on the phone. Refusing to show it would stop Kim helping the caller, which is worse for the resident than one missing record that Sentry reports.

## What this changed from the original plan

The first version of the database rule also refused to record a view of a contact the staff member couldn't see. Measured on prod, that check added about 0.6 seconds to every call pop, because it re-runs the whole contacts permission rule. Without it a write takes under a millisecond. All the check would have stopped is a staff member recording, under their own name, a view of a resident they can't open. That reveals nothing about the resident, so we dropped the check. Recording a view in someone else's name, or backdating one, is still refused.
