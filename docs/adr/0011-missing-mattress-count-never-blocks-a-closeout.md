# 0011 — A missing mattress count never blocks a crew closing out a stop

- **Date:** 03/08/2026
- **Status:** Accepted

## Decision

When a crew closes out a stop that should carry a mattress count (Verge Valet's bulk pass), a closeout that arrives **without** a count is accepted — the stop completes and the count is recorded as "uncounted" (blank, distinct from an entered 0). Each uncounted closeout raises an internal alert so we can see which phone is running an outdated app. Only a genuinely invalid entry (a negative or absurd number) is still rejected.

## Why

On 03/08/2026, the first collection day after the mattress counter shipped, the bulk crew's phone was still running the previous version of the field app — phones keep the app open for days, so they don't pick up a new release mid-run. The old app had no counter and could never send a count, and the server's original "no count, no closeout" rule rejected every attempt. Result: 34 residents' piles couldn't be marked collected all morning, and the crew saw no usable error. Blocking resident service to force a reporting number is the wrong trade — the report can say "uncounted"; a resident's collection can't wait for an app update.

## What this changed from the original plan

The mattress feature (#487) shipped the count as a hard requirement: the server refused any flagged closeout without one, deliberately mirroring the MUD counts gate. The MUD gate protects billing-relevant quantities; the mattress count is reporting only, so it doesn't earn the same severity. The requirement is now enforced by the app's counter (which always sends a number, with 0 as a one-tap answer) plus an alert on every uncounted closeout — not by blocking the crew. The same incident also added an automatic app-refresh when a crew phone is found running an outdated version, so this whole class of "old app vs new server" failure clears itself within minutes of a release.
