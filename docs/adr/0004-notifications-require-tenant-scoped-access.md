# 0004 — A notification only sends if the person triggering it could see that booking themselves

- **Date:** 12/07/2026
- **Status:** Accepted

## Decision

When a logged-in user's action triggers an email or SMS about a booking, the system first checks that this user could read that booking under their own access rules. If they can't, nothing is sent and the request is rejected.

## Why

This closed a cross-tenant hole. The notification sender has elevated database access (it needs to read contact details and council branding), so before the gate, a staff login from council A could — by calling the function directly — have triggered a Verco-branded email to council B's resident, including one claiming a fake refund. The fix reuses the same row-level permissions the database already enforces everywhere else: "could you read this booking yourself?" is the test, so there is no second permission system to keep in sync. Shipped in the 11–12/07/2026 hardening batch (PR #403, tightened in #409, pinned by tests in #416).
