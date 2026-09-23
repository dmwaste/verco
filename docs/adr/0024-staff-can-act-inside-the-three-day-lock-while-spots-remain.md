# 0024 — Staff can book inside the 3-day lock while spots remain; the ceiling never moves

**Date:** 23/09/2026 · **Status:** Accepted

## What we decided

Office and council staff can place two kinds of job inside the 3-day window before a collection day, as long as that day still has room:

1. an **illegal-dumping collection**, and
2. an **ad-hoc redo for a property whose collection failed** — both a non-conformance notice and a nothing-presented record.

Residents cannot. Neither can anyone book a day that is closed for a public holiday or closed by an admin — no crew runs then. And nobody, in any role, can push a day past its capacity through these paths.

**An ad-hoc redo also has to be arranged before 3:00pm the day before** — the cut-off WMRC publishes to residents. Without it, someone could create a redo for tomorrow at 9pm, an hour after the crews took their routes, and it would reach OptimoRoute on the next hourly push with nobody having told the driver. Dates further out are unaffected: a Wednesday job can still be arranged at 9pm on Monday.

## Why

WMRC made both a condition of moving the remaining five Verge Valet councils onto Verco on 01/10/2026. Their staff field the calls: someone reports a dumped pile, or a resident's collection was knocked back for the wrong waste, and the fix usually needs to happen this week, not next. WMRC named non-conformance; nothing-presented gets the same treatment because it is the same phone call — the resident's waste is on the verge and the crew didn't take it. Splitting the two would leave staff able to fix one and not the other for no reason they could explain. Before this, the 3-day lock refused them and the only way through was to ring D&M and have a contractor-admin do it.

The lock exists to protect dispatch: three days out, a day's work is sent to OptimoRoute, the place-out SMS goes to residents, and the crews get their routes at 8pm the night before. Those things stay true. What we've separated is "this day is locked for planning" from "this day is full" — only the second is a hard ceiling.

## What this changes for the crews

A job added inside the window can still land after the day's work has gone to OptimoRoute (that happens three days out), though the 3:00pm rule keeps it ahead of the 8pm route handover for a next-day job. The picker labels those dates "within 3 days, tell the crew", and ops adds the stop in OptimoRoute by hand. The hourly push means anything added before the route goes out still flows through normally.

## The honest limit

The redo paths (both kinds) check the remaining spots when they save, but do not hold a lock while they do. Two people rebooking onto the last spot of the same day at the same moment could both succeed, putting that day one over. We accepted this because these are deliberate, low-volume office actions on days with 60 bulk spots or 5 illegal-dumping spots, and being one over is an operational nuisance, not a money or safety problem. The illegal-dumping path, which already ran through a database function, does take the lock. If ad-hoc redos ever become common, the fix is to move that write into a database function too.

## What we rejected

- **Letting council staff book holidays and admin-closed days.** WMRC asked for the 3-day window, not for closed days. A booking on a day with no crew strands the resident.
- **Reading the existing "closed" flag.** It means "locked or full" in one value, so it cannot answer "is there room?". All three paths now read the actual counters.
- **Applying the 3:00pm rule to illegal-dumping collections as well.** Not decided here. WMRC's cut-off is about collections residents booked; a reported dumped pile is council work with its own urgency. Revisit if it causes a crew surprise.
- **Removing the lock, or shortening it.** It is what makes the place-out SMS and the 8pm route handover possible.

## Related

- [0014](0014-client-tier-date-moves-respect-capacity.md) — council staff can't move a booking onto a full date; D&M staff still can. Same principle: the closure relaxes, the ceiling does not.
- [0018](0018-rescheduling-cancels-the-old-days-job-immediately.md) — why 8pm the night before is the deadline every dispatch change has to beat.
