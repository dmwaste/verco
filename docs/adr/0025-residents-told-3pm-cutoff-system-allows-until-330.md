# 0025 — Residents are told the cutoff is 3:00pm; the system still allows changes until 3:30pm

- **Date:** 30/09/2026
- **Status:** Accepted

## Decision

Everything a resident reads says the change/cancel cutoff is **3:00pm the day before collection**: the FAQ, the Verge Valet T&Cs, the collection reminder email, the dashboard countdown, the booking page's cutoff card, and the "cutoff has passed" error messages. The system itself keeps enforcing **3:30pm** (the database trigger, the app's checks, and the 3:25pm scheduling job are unchanged). The 30 minutes in between is a quiet grace window.

Staff-facing screens and messages keep saying 3:30pm, because that is what staff can actually do.

## Why

Dan wanted residents to aim for 3:00pm. Moving only the words, not the enforcement, means a resident who is a few minutes late still gets their change through rather than losing their allocation, and nothing about scheduling, run sheets or the OptimoRoute push has to move. Only the FAQ text was asked for, but the T&Cs and reminder email also said 3:30pm, so changing the FAQ alone would have told residents two different times.

Anyone "fixing" the mismatch later must choose deliberately: either move enforcement to 3:00pm (a database migration, and residents lose the grace), or move the wording back to 3:30pm. In code, `advertisedCancellationCutoff` is for display only. Every gate uses `cancellationCutoff` / `isPastCancellationCutoff`.
