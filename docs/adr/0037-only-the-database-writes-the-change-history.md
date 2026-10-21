# 0037 — Only the database writes the change history, and staff see a record's history only if they can see the record

- **Date:** 21/10/2026
- **Status:** Accepted

## Decision

The change history (the audit log) is written only by the database itself: the trigger that records every change, plus D&M's back-end functions. Nobody can add an entry through the app's public interface any more, whether signed in or not.

Council and WMRC staff also no longer see history entries for records that are D&M-only. Today that is the office's corrections to a crew's closeout, whose reason is D&M's internal note (ADR 0030). D&M staff see everything as before.

## Why

While building ADR 0036 we found that anyone holding Verco's public website key (it ships in every page) could add made-up entries to the change history. Staff would then see those entries in a booking's History as if they were real: a fake "status changed by …" line, for example. History is what staff and councils rely on to settle "who did what, when", so a forged entry is as damaging as a lost one. Nothing in Verco needed that door open.

Council and WMRC staff could also read the history of closeout corrections, even though the corrections themselves are D&M-only. The history copied the internal reason word for word. A record's history now follows the same rule as the record.

## What this changed from the original plan

The audit log was set up in March 2026 with an "anyone may insert" rule that was never used: the trigger and D&M's back-end never needed it. Removing it changes nothing anyone does today. Any future table whose own records are D&M-only must be added to the same D&M-only list. An automated check in the code fails until it is.
