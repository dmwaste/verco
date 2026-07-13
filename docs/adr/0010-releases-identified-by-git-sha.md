# 0010 — Releases are identified by code snapshot (git SHA) and verified live, not version numbers

- **Date:** 02/07/2026
- **Status:** Accepted

## Decision

There is no VERSION file and no CHANGELOG. A release is identified by its exact code snapshot (the git SHA). The live site reports its own SHA at `/api/health`, and every release is verified by checking that the live SHA matches what was just cut. Day-to-day fixes land on the `develop` branch; production only updates when a batch of `develop` is cut to `main`, giving one deploy per batch rather than one per change.

## Why

Version numbers are a label someone has to remember to update — they can lie. The SHA can't: it *is* the code. This matters because Verco has had a "ghost release" — a cut where the deploy step silently didn't run and production kept serving the old code while everything looked done. Checking `/api/health` after each cut turns "the deploy probably went out" into proof. Batching deploys keeps production changes to deliberate, reviewable moments instead of a trickle. GitHub PR history serves as the changelog.
