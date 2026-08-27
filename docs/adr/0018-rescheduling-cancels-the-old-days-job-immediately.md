# 0018 — A rescheduled booking reaches OptimoRoute before the crews get their routes

- **Date:** 27/08/2026
- **Status:** Accepted

## Decision

Crews get their routes at **8pm the night before**. Everything Verco sends to OptimoRoute is now timed around that deadline rather than around midnight:

- Changing a booking's date cancels the crew job for the day it moved off **immediately**, and that job is pulled out of OptimoRoute within the hour.
- New and changed jobs are sent to OptimoRoute **hourly**, not once a day at 3:10am.

## Why

On 26 August a Kwinana booking (KWN-4-X96WUS, 7 Stefanelli Cl, Wandi) was moved from Thursday 27 August to Thursday 3 September at 7:57am. The booking moved, but the job already sent to OptimoRoute for the 27th did not. Nine hours later the routing engine handed that job back to us planned into the 27th's route — a truck, a position in the run, and an 8:13am arrival time — for a resident who was no longer booked that day. It was only cancelled at 3:10am on the 27th, which is **after the 8pm dispatch**, so the crews went out that morning with it still on their route. Eleven live bookings have hit this since July.

The same 3:10am timing broke the opposite case just as badly, and more quietly. A booking moved *onto* a date in the last three days before collection didn't reach OptimoRoute until 3:10am on the collection morning — again after the crews had their routes. Anything changed between 3:10am and 8pm on the day before collection fell into that hole: the resident is booked, they show on the Verco run sheet, and they are not on the truck's route. That is a missed collection with no warning to anyone.

Neither rule was wrong — only the timing. The overnight job already knew how to work out that a job was stale, and how to send new work; it just ran once a day, at the one hour of the day that was too late to matter. Both now run on a cadence that beats the 8pm cut.

## What this changed from the original plan

Nothing about ADR 0009 (the crew job sheet is frozen history; corrections live on the booking). A job a crew has already closed out — completed, or written up as a non-conformance or nothing-presented — is still left exactly as it was, so back-dating a booking can never turn a wrong-day miss into an on-time success. Only a job the crew has not yet touched is cancelled, and it is cancelled, never quietly moved to the new date. The new date gets its own fresh job when that date locks three days out.

Sending work hourly does not disturb routes ops have already planned. An unchanged job is never re-sent — only genuinely changed ones are, and those are changes ops need to see. Before this, those same changes still went out, just at 3:10am, after the crews had already left with the old version.

**The 8pm dispatch is the deadline any future change to this pipeline has to respect.** It is an operational fact that lives outside the codebase, which is why it is written down here.
