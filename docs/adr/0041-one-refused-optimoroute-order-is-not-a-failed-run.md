# 0041 — One refused OptimoRoute order is that order's problem, not a failed run

- **Date:** 27/10/2026
- **Status:** Accepted

## Decision

When OptimoRoute refuses a single order, Verco records the reason on that stop, retries it every hour, and tells ops **once** in the Verco alerts Teams channel. Examples: OptimoRoute already holds two orders with the same number, or the stop has no map pin. The hourly push is logged as **partial**, not failed, and raises no Sentry error.

A run still counts as **failed**, and raises a Sentry error every hour, when the push itself breaks: OptimoRoute or our database rejects the whole call, or 10 or more orders are refused and nothing gets through.

## Why

From 24/10 to 27/10/2026, one stop (SOP-VHPDL0-G) made every hourly push report "failed". OptimoRoute held two orders with that number, most likely a copy made inside OptimoRoute when the job was rescheduled from 22/10. That was about 80 runs and 24 or more Sentry errors a day, while every other order went through. An alarm that goes off every hour for one known stop trains people to ignore it. Then a real outage, like 19/10 when nothing reached OptimoRoute for 17 hours, gets missed.

The same incident hid the actual reason. When the refused order was the only one in a run, OptimoRoute's reply was read wrongly and logged as a generic "create_or_update_orders failed". The stop's own message now survives.

**How "once" works:** each stop already stores its last push error. Ops are told when that error first appears or changes. While it stays the same, the hourly retry stays quiet. If Teams is down at that moment, Sentry gets a warning and the run log still lists the stop.

**Verco never deletes OptimoRoute orders itself.** Ops remove the duplicate by hand, and the next hourly push goes through.

## What this changed from the original plan

The push's run log had two outcomes, success and failed, and any refused order meant failed. It now has a third, **partial**. Anything that reads the log must treat partial as "needs a look", not as healthy. That includes the PA's daily brief.

This follows ADR 0032: a row that the next run retries is not an outage. Each refused order is still named, just not every hour.
