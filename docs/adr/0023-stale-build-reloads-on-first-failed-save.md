# 0023 — A stale app build reloads itself the first time a save fails, on every screen

- **Date:** 13/09/2026
- **Status:** Accepted

## Decision

When a crew phone or staff tab is still running an app build from before a deploy, the first save the new server refuses reloads the page automatically — on every field, admin and resident screen — and the message reads "App updated — reloading…" rather than blaming the phone signal. It reloads at most once every 30 seconds, so a deploy still in progress can't put a phone into a reload loop; a second refusal inside that window says "reload the page to continue". Moving between pages needs nothing extra: Next.js already swaps a stale build for the live one on the next page change or refresh.

## Why

Verco ships several deploys a week, and today every deploy changes the identity of every save action, so an open tab's next save is refused whether or not that action changed. The field app reported this as "No connection — check signal and retry.", a retry that could never work until someone reloaded — the same dead-button failure as the 03/08/2026 closeout outage (ADR 0011). The Sentry report for 5–11 September recorded it on real devices after each of the week's five deploys. The reload does cost the crew whatever they had typed on that screen, once per deploy; that is the follow-up below, not a reason to leave the button dead.

## What this changed from the original plan

The first cut of this change polled the server's build id on every page change. That duplicates what Next.js already does, so it was dropped; only the failed-save path needed handling. Follow-up for Dan: pin `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` as a build secret so unchanged actions keep their identity across deploys — then most deploys are invisible to open tabs and only a genuine contract change triggers the reload (which is what the "accept the old arguments for one release" rule in CLAUDE.md §21 was written for).
