# Decision Log (ADRs)

An ADR — "architecture decision record" — is a short record of a decision we made and why, so we stop re-arguing settled questions. Each file below is one decision, written in plain English for a non-developer reader: what we decided, why, and (where it applies) what it changed from the original plan. To add one, copy `template.md`, take the next number, keep it jargon-free, and add a row to the table below. If later work contradicts an ADR, say so explicitly and either reopen the decision with Dan or write a new ADR that supersedes it — never silently override.

| # | Decision | Date | Status |
|---|---|---|---|
| [0001](0001-refund-approval-is-verco-internal.md) | Refund approval happens in Verco, not DM-Ops | 12/07/2026 | Accepted |
| [0002](0002-every-refund-is-auto-raised-owed-money.md) | Every refund request is auto-raised owed money — no discretionary refunds | 12/07/2026 | Accepted |
| [0003](0003-only-admins-can-move-refund-money.md) | Only admins can approve the actual refund payment | 12/07/2026 | Accepted |
| [0004](0004-notifications-require-tenant-scoped-access.md) | A notification only sends if the person triggering it could see that booking themselves | 12/07/2026 | Accepted |
| [0005](0005-refund-amounts-come-from-the-server.md) | Refund amounts shown or emailed always come from our own records, never the request | 12/07/2026 | Accepted |
| [0006](0006-edge-functions-typed-against-the-database.md) | Server functions are machine-checked against the real database layout | 12/07/2026 | Accepted |
| [0007](0007-applied-migrations-are-immutable.md) | A database change already applied to production is never edited — new changes get a new file | 12/07/2026 | Accepted |
| [0008](0008-quantity-edits-guarded-against-simultaneous-changes.md) | Editing a paid booking's quantities is guarded against two people editing at once | 12/07/2026 | Accepted |
| [0009](0009-stop-is-dispatched-record-booking-is-corrected-intent.md) | The crew job sheet is frozen history; corrections live on the booking; on-time KPI uses the frozen record | 11/07/2026 | Accepted |
| [0010](0010-releases-identified-by-git-sha.md) | Releases are identified by code snapshot (git SHA) and verified live, not version numbers | 02/07/2026 | Accepted |
| [0011](0011-missing-mattress-count-never-blocks-a-closeout.md) | A missing mattress count never blocks a crew closing out a stop | 03/08/2026 | Accepted |
| [0012](0012-booking-item-staff-rules-enforced-by-trigger.md) | Council-staff booking-item rules are enforced by a database trigger, not only in app code | 22/08/2026 | Accepted |
| [0013](0013-properties-edited-in-place-not-recreated.md) | Properties are corrected in place, never "mark ineligible and recreate" | 22/08/2026 | Accepted |
| [0014](0014-client-tier-date-moves-respect-capacity.md) | Council staff can't move a booking onto a full date; D&M staff still can | 22/08/2026 | Accepted |
| [0015](0015-nightly-dm-ops-sync-retired.md) | The nightly DM-Ops sync is retired, not fixed | 23/08/2026 | Accepted |
| [0016](0016-legacy-surveys-without-bookings.md) | Imported Airtable surveys live in Verco without a booking | 23/08/2026 | Accepted |
| [0017](0017-monthly-client-report-bills-attended-collections.md) | The monthly client report bills attended collections, not just clean ones | 25/08/2026 | Accepted |
| [0018](0018-rescheduling-cancels-the-old-days-job-immediately.md) | A rescheduled booking reaches OptimoRoute before the crews get their routes at 8pm | 27/08/2026 | Accepted |
| [0021](0021-geocoder-refuses-a-match-in-the-wrong-suburb.md) | The geocoder refuses a match in the wrong suburb rather than storing it | 02/09/2026 | Accepted |
