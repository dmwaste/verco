# 0036 — Council staff see their own council's change history again; contact changes stay with WMRC and D&M

- **Date:** 21/10/2026
- **Status:** Accepted

## Decision

Every entry in the change history (the audit log) now records which council it belongs to. A council officer (for example a Peppermint Grove officer under Verge Valet) sees the history of their own council's bookings, properties, collection days, rules, notices, tickets and crew stops, and nothing from any other council. WMRC-wide staff, Kwinana staff and D&M see exactly what they saw before.

Some entries belong to no single council. They stay hidden from council officers and visible to WMRC-wide and D&M staff:
- changes to a **contact record** (name, email, mobile);
- general enquiries that aren't tied to a booking, and replies to them;
- bug reports, the client record itself, and old staff-account entries.

Entries written before this change are tagged by a one-off script run after the release. Until it has run, council officers see only new history. An untagged entry is always hidden from them, never shown to the wrong council.

## Why

On 30/09 we found the audit log let council officers read other councils' residents' contact history, and the hotfix (ADR 0024) hid the whole log from them. That left every History panel and the Audit Log page blank for council staff, so they couldn't see who changed a booking or when.

Contact records are kept out on purpose. One contact can sit on bookings in several councils (46 Verge Valet contacts do today). Contacts that were merged by a shared email and later split apart (ADR 0027) still carry other councils' residents' old names and phone numbers in their history. Those before-and-after copies are exactly what leaked on 30/09. Council officers still see the current contact details on their own bookings; they just don't see the edit trail of a contact record.

## What this changed from the original plan

ADR 0024 hid the audit log from council officers as a stopgap until each entry could be tagged by council. This replaces that stopgap. Issue #614 also asked for an index on the new council column. Measured on prod, the database can't use one for this rule, and the Audit Log page's total count would have slowed from 0.2 s to about 6 s for everyone. So the index is on the client and date instead, with the council column carried inside it. It also makes the page's first screen load in milliseconds where it took 5.8 s for WMRC-wide staff.
