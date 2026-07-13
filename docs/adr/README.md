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
