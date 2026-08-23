# 0015 — The nightly DM-Ops sync is retired, not fixed

- **Date:** 23/08/2026
- **Status:** Accepted

## Decision

The 3am cron that was meant to push booked-collection stats from Verco into DM-Ops is unscheduled. The Edge Function stays in the repo, but nothing calls it any more.

## Why

The sync never worked — not once since it was scheduled on 27 March. Two independent reasons: the DM-Ops connection secrets were never set, and DM-Ops' booked_collection table grew a different shape (per-service columns) from the aggregate payload the sync sends. It failed invisibly for five months, and once cron observability shipped (#518) it would have paged Dan every single night. Meanwhile DM-Ops has been getting these numbers another way all along — its table holds over a thousand rows. Fixing the sync means redesigning its contract for no operational gain; retiring it costs nothing and stops the alerts.

## What this changed from the original plan

The v2 spec included the nightly sync as the one write path from Verco into DM-Ops. That path is now dormant. Red Line #6 (only this Edge Function may ever touch DM-Ops tables) still stands. Reviving the sync needs a payload redesigned against DM-Ops' real schema, the two DM_OPS_* secrets set, and a new migration to re-schedule the cron.
