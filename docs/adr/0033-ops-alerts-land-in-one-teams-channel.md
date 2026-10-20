# 0033 — Ops alerts land in one Teams channel, and a missing channel is itself an alert

- **Date:** 20/10/2026
- **Status:** Accepted

## Decision

Every Verco watchdog sends its "something is wrong" message to **one Microsoft Teams channel**, through a Teams Workflows webhook link stored as the `OPS_ALERT_WEBHOOK_URL` secret. If that link is missing, or Teams refuses the message, Sentry gets a warning on every run until it's fixed. The watchdog never stays quiet.

## Why

The notification watchdog (built after two multi-day email/SMS outages) ran for three months with nowhere to send its alerts. The link was never set, and nothing could tell a watchdog with no channel from one with nothing to report. Outages here have run for weeks before anyone noticed (the Verge Valet confirmation outage ran 29/06–24/08), so the alert path has to work, and has to say loudly when it doesn't.

Teams, because that's where D&M already works. Not email, because SendGrid is one of the things being watched, and an alert about a dead email channel can't depend on that same channel. Not Sentry alone, because Sentry is a developer tool, not where the ops team looks. Sentry stays as the backstop for when Teams itself is broken.

Alerts carry counts, booking refs and admin links only, never resident names, emails or phone numbers. The webhook link counts as a password: it's never committed, pasted or logged.

## What this changed from the original plan

The watchdog was written for a Slack-style webhook (`{ text }`), and a missing link was treated as fine (logged, HTTP 200). Slack isn't used at D&M, and Microsoft retired the old Teams "incoming webhook" connectors. So the default format is now a Teams Workflows card, with `OPS_ALERT_WEBHOOK_FORMAT=slack` keeping the old shape available. A missing link still doesn't fail the run, but it now raises a Sentry warning on every run.
