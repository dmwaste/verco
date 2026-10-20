# 0034 — Stale closeouts are named once; the open backlog is restated on Mondays

- **Date:** 20/10/2026
- **Status:** Accepted

## Decision

Every morning at 09:35 the stale-closeout alert looks at the collection day three days back. If any stops from that day are still not closed out, or a booking from that day never reached the crews (no open crew job), it posts one message to the ops Teams channel. The message names each council area with its counts and restates everything else still open underneath. On a day with nothing newly stale it stays quiet, except on Mondays, when it restates the open backlog on its own if any remains.

## Why

Cambridge ran 204 collection stops and closed out none of them, and nobody noticed for two weeks. Stops that are never closed out are unbilled and unproven work, and they make the council's on-time figures look worse than the work D&M actually did.

Each collection day gets named exactly once, on the day it crosses three days old, so the alert reads as news, not wallpaper. Repeating the same backlog every morning would get muted within a week. Staying silent about it would let a council that went dark once, and then had no more collection days, drop out of sight. A Monday restatement sits between the two.

Three days, because crews normally close out the same day. Two days of slack covers a late closeout without raising a false alarm.

## What this changed from the original plan

The spec (#575) alerted only on newly stale days and otherwise posted nothing. The Monday restatement was added so the backlog can't hide behind quiet days. If a morning run is missed entirely, that day is never named on its own. It still counts in the backlog totals and shows up again on the next Monday.
