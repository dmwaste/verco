# 0017 — The monthly client report bills attended collections, not just clean ones

- **Date:** 25/08/2026
- **Status:** Accepted

## Decision

The monthly client report — the document that backs each council invoice — now counts a collection as billable when the crew attended the property, whatever they found there. That means **Completed, Non-conformance and Nothing Presented**. Cancelled, Scheduled, Rebooked and Missed Collection are still excluded.

## Why

D&M gets paid for turning up. Both councils pay the normal rate for an attendance whether the crew collected a clean pile, wrote a non-conformance notice, or found nothing on the verge. The report was only counting Completed, so every non-conformance and every nothing-presented vanished from the invoice and from the statement we send the council.

For City of Kwinana in July 2026 that was **420 units** — the report showed 1,428 where 1,848 were attended — and the statement told the City we made 1,434 collections when the real figure was 1,854. Those 255 missing non-conformances are precisely the record you want to hand back when a resident disputes one. August was accruing the same way, at roughly 307 units by the 25th. Verge Valet had the identical defect on the same code path (114 units in July) because the function is parameterised by client.

The four exclusions each have a reason:

- **Cancelled** — nobody attended.
- **Scheduled** — the outcome was never recorded. A past-dated booking still sitting on Scheduled is unfinished work, not free work; it has to be closed out before invoicing. Leaving it out means it shows up as a shortfall rather than being billed as an outcome we never observed. (August had 117 such bookings across both clients on the day this was written.)
- **Rebooked** — the job failed and we went back. It bills once, on the redo. The council is not charged twice for one property because our first attempt missed it.
- **Missed Collection** — no code path writes it and no booking has ever held it, but the same logic would apply.

This is deliberately narrower than the "reached the field" set the council dashboard uses (`get_collections_trend`, which also counts Scheduled and Missed Collection). The invoice and the dashboard will therefore differ by exactly the amount of unclosed work. That gap is a useful signal, not a defect.

The crew-logged mattress branch (Verge Valet close-outs) widens to the same three statuses: a mattress the crew physically loaded is billable even when the stop's overall outcome was a non-conformance. No units move today — every non-conformance stop carrying a count logged zero — but the rule is now the same on both sides of the report.

## What this changed from the original plan

The original build (migration `20260806153039`, August 2026) set the opposite rule on purpose. Its header states it: booked units bill only when the *whole* booking finished Completed, on the reasoning that a redo would bill instead. That reasoning assumed a failed attendance is not chargeable, which is not how either contract works. The old rule is now reversed, and a unit test (`src/__tests__/reports/client-monthly-billable-statuses.test.ts`) reads the live migration and fails if the status set is ever narrowed or widened without a deliberate change here.

The report's layout is explicitly unchanged — two tables, **Included Collections** and **VERCO Extra**. No non-conformance breakdown column and no third table were added; councils wanting that detail can view it in the Verco admin panel. Only the numbers move.
