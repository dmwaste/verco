# 0027 — An email address is not always one person: editing a contact can never change someone else's booking

- **Date:** 12/10/2026
- **Status:** Accepted

## Decision

Verco still finds a booking's contact by email, but a matching email alone no longer allows that contact record to be changed. A contact record is only edited when the change can't reach anyone else's booking:

- **Same person** (same name and mobile already on file): the booking reuses that record and nothing changes.
- **A resident signed in and booking for themselves:** their own record is updated, as before.
- **Same household** (the record is used only at this address and isn't a MUD strata contact): it's updated in place, so a partner on a shared email or a new mobile number still corrects the household's record.
- **Anything else:** the booking gets a **new** contact record of its own.

The same rule applies to staff editing the contact on a booking (if the contact is used at any other address, or is a strata contact, only this booking moves to the new details) and to saving a MUD's strata contact (a record that residents' bookings use is never rewritten from the MUD page). The Verge Valet booking import reuses a record only for the same person and never edits one. A staff member booking on someone's behalf under their *own* email is not "booking for themselves".

Support tickets, staff-created logins and the Kwinana importers follow the same rule (#631, 13/10/2026):

- **A support ticket** about a booking treats that booking's address as the household. A ticket with no booking has no address, so it reuses a record only for the same person, or the signed-in resident's own single record.
- **A staff-created login** has no address of its own, so an existing record is only corrected when it's used at one address at most and isn't a strata contact. Otherwise the new user gets their own record.
- **The Kwinana booking importers**, like the Verge Valet one, reuse a record only for the same person and never edit one.

## Why

Staff took phone bookings under the WMRC office email, so one contact record ended up on 278 residents' bookings at 272 addresses. Every new phone booking rewrote that record's name and mobile, so reminders for everyone else went to the newest resident. Then, on 05/10/2026, one booking's contact was corrected to a strata company's details, and all 278 bookings switched to them at once. Notices for residents' addresses reached people who had nothing to do with them.

The cost of the new rule is that the same email can now sit on several contact records. A resident who has an account and is booked by staff under a different name at a *different* address will see that booking under the address lookup, not on their dashboard. We judged that far smaller than sending one resident's address and collection date to another. In code, the rule lives in `supabase/functions/_shared/contact-match.ts` (`resolveContact`) and in migration `20261012150000`.
