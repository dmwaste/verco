# 0032 — A busy reminder morning is not an outage: only the last run of the day raises the alarm

- **Date:** 20/10/2026
- **Status:** Accepted

## Decision

The collection-reminder job runs four times each morning: 9:00, 9:10, 9:20 and 9:30. If an earlier run can't finish everyone, it reports "partly done" (HTTP 207) and the next run picks up the rest. Sentry only raises an error when the **9:30 run** still leaves residents without a reminder, or when a run crashes outright.

## Why

Supabase limits how fast one of our server functions can call another, so each run can send about 120 reminders. On any day busier than that, handing the rest to the next run is how the system is meant to work. Until now every hand-over counted as a failure. On 19/10/2026 the 9:00 and 9:10 runs both raised a high-priority Sentry error, yet the 9:20 and 9:30 runs reminded all 188 residents. An alarm that goes off on every busy day trains people to ignore it, and then a real miss gets ignored too.

Only the 9:30 run can tell a real miss from a hand-over, because nothing runs after it. So that's the only run that alerts. A resident who would miss out still raises the alarm, about half an hour later than before.

The schedule itself says which run is last: the 9:00, 9:10 and 9:20 runs are told "not the last run", and the 9:30 run is told "last run". A run that isn't told either way (one started by hand, or a run someone adds later and forgets to label) is treated as the last run, so it alerts rather than hides a miss. Changing the schedule never needs a code change.

## What this changed from the original plan

The rule for every scheduled job was "report an error if any row fails". That still holds for jobs that run once. For a job that retries itself within the hour, the error now comes only from the run that has no retry left.
