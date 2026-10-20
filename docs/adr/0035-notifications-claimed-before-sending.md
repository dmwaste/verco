# 0035 — A notification is claimed before it is sent, so a retry can't send it twice

- **Date:** 20/10/2026
- **Status:** Accepted

## Decision

Before Verco sends an email or text, it writes that message's log row first, marked "queued". The database allows only one queued-or-sent row per booking, message type and channel. A second attempt at the same message finds the row already there and stops. Once the send finishes, the same row is marked "sent" or "failed". A failed row doesn't block the next try.

Because of that, the booking-confirmation hop keeps retrying when the gateway times out (a 504, or our own 10-second limit). Staff-made MUD bookings get the same retries now too, plus a "failed" row when the confirmation still can't get through.

## Why

On 18/10 we added retries after two residents silently got no confirmation (#664). A timeout doesn't tell us whether the first attempt had already started sending. With the old check ("is there a *sent* row yet?"), a retry inside that gap sent a second email and a second text. One confirmation is right; two looks broken. Claiming first closes the gap. Postgres settles it, so it holds even when two attempts land at the same moment.

A dispatcher that crashes mid-send leaves its claim stuck on "queued". The watchdog treats that booking as unconfirmed and alerts. Any later attempt after 10 minutes releases the stuck claim and sends.

## What this changed from the original plan

Issue #671 offered a simpler fix: never retry a 504 or a timeout, record "failed", and leave the rest to the watchdog and a staff retry. We didn't take it. A 504 is when the gateway gave up waiting, often before our code even ran, so a resident would still go hours without a confirmation, which is the problem #664 fixed. A staff retry could also double-send in the same way. The claim protects every path that sends: the retrying caller, the admin Retry button, reminders and the cron jobs.
