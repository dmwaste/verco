# 0011 — Mattress counts: crews log at bulk closeout; one daily series feeds every report

- **Date:** 01/08/2026
- **Status:** Accepted

## Decision

Mattress numbers come from two sources folded into one report series. Kwinana books Mattress as its own service, so its counts already exist as booking line items — nothing new to enter. Verge Valet rolls mattresses into the bulk booking, so the crew enters a mattress count when they close out the bulk stop — the count is required on every closeout path (Complete, Non-conformance, Nothing Presented), defaults to 0, and is saved in the same instant the stop closes. One day-granular report query (`get_mattress_daily`) serves both councils and both views (daily and monthly).

Which pass prompts for the count is data, not code: a per-council setting (`client.mattress_closeout_stream`) names the pass, and a blank setting means the council never prompts. Which service counts as a mattress is a flag on the service (`service.is_mattress`), never its display name.

## Why

WMRC wants mattress numbers for its reporting and, until now, they did not exist anywhere — mattresses ride the bulk pile with no record. A skippable field would simply be skipped by a crew in gloves at a verge, so the count is required with 0 as a one-tap answer (the same rule the MUD counts follow). Saving the count only at the moment the stop closes means the number can't drift afterwards — a blank forever means "never logged" while 0 means "the crew said zero", which keeps the council report honest. Keying the report off a service flag instead of the name "Mattress" means renaming the service in the admin UI can never silently blank a council's report (that class of breakage has bitten before, #228).

## What this changed from the original plan

The issue sketch (#487) suggested adding a mattress series to the existing shared monthly reports query. We built a small dedicated **daily** query instead: the request was explicitly for per-day counts, which a monthly series cannot carry, and one daily query feeds both the daily numbers and the monthly sparkline — one source of truth, and no re-release of the large shared query every dashboard card depends on.
