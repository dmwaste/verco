# 0023 — Every crew and admin screen swaps a stale app build for the live one on its next navigation

- **Date:** 13/09/2026
- **Status:** Accepted

## Decision

Every field and admin page checks, each time the user moves to another page (at most once every five minutes), whether the app build it is running matches the build the server is serving, and reloads itself once if not. A save that fails because the build is stale reloads the page instead of telling the crew "No connection — check signal and retry." Previously only the run sheet did this, and only when the phone regained focus.

## Why

Verco ships several deploys a week. A crew phone or a council staff tab left open across a deploy keeps running the old build; its next Save is refused by the new server, and the app blamed the phone signal. The crew retried a button that could never work until they reloaded — the same failure class as the 03/08/2026 closeout outage (ADR 0011). The week of 5–11 September had five deploys and Sentry recorded real devices hitting this after them. Checking on navigation rather than on focus means a reload can never throw away a half-filled closeout or booking form.

## What this changed from the original plan

ADR 0010 put the build check on the run sheet only, on focus. This extends it to every field and admin screen on navigation; the run sheet keeps its focus-time check as well. Resident pages are deliberately left out: residents rarely keep a tab open across a deploy, and the booking flow carries state a reload would lose.
