# 0018 — Rescheduling a booking cancels the old day's job straight away, not overnight

- **Date:** 27/08/2026
- **Status:** Accepted

## Decision

The moment a booking's collection date is changed, the crew job for the day it moved off is cancelled — and the routing engine's copy of it is removed within the hour. It is no longer left to the overnight job to notice the next morning.

## Why

On 26 August a Kwinana booking (KWN-4-X96WUS, 7 Stefanelli Cl, Wandi) was moved from Thursday 27 August to Thursday 3 September at 7:57am. The booking moved, but the job already sent to OptimoRoute for the 27th did not. Nine hours later the routing engine handed that job back to us planned into the 27th's route — a truck, a position in the run, and an 8:13am arrival time — for a resident who was no longer booked that day. Only at 3:10am on the 27th, the morning of the collection, did the overnight job spot the mismatch and cancel it.

Three things go wrong in that window. Ops plan the next day's routes around a stop that shouldn't exist. OptimoRoute sends the resident its own "we're on the way" notifications for a day they didn't book. And the crew can be sent to a property with nothing out. Eleven live bookings have hit this since July.

Nothing about the rule was wrong — only its timing. The overnight job already knew how to work out that the job was stale; it just ran once a day, at 3:10am. The same rule now runs the instant the date is changed, so the routing engine is cleaned up within the hour instead of up to a day later.

## What this changed from the original plan

Nothing about ADR 0009 (the crew job sheet is frozen history; corrections live on the booking). A job that has already been closed out by a crew — completed, or written up as a non-conformance or nothing-presented — is still left exactly as it was, so back-dating a booking can never turn a wrong-day miss into an on-time success. Only a job the crew has not yet touched is cancelled, and it is cancelled, never quietly moved to the new date. The new date gets its own fresh job when that date locks three days out, exactly as before.

There is a matching gap in the other direction that this does **not** fix: a booking moved *onto* a date that has already locked doesn't get its new job sent to OptimoRoute until 3:10am on that collection morning, after ops have planned the route. Left as-is deliberately — closing it means sending new work to the routing engine more often, which can disturb routes ops have already planned, and that's an operational call rather than a bug fix.
