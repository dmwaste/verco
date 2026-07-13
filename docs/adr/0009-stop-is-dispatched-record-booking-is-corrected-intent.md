# 0009 — The crew job sheet is frozen history; corrections live on the booking; on-time KPI uses the frozen record

- **Date:** 11/07/2026
- **Status:** Accepted

## Decision

When bookings are dispatched to crews, each job becomes a "collection stop" — a frozen record of exactly what was sent out, including its collection date. If an admin later corrects a booking (say, moves its date), the booking changes but the stop does not. The contractual on-time KPI reported to councils is measured against the stop's date, never the booking's.

## Why

If the on-time number were measured against the booking's (correctable) date, a wrong-day miss could be made to look on-time after the fact just by back-dating the booking — laundering a contractual failure into a success. Keeping the stop as untouchable history means the KPI reflects what was actually dispatched and when it was actually done. A booking and its stop showing different dates is therefore deliberate — one is the corrected intent, the other is the audit record — and should never be "fixed" to match. Pinned as an explicit invariant on 11/07/2026 (#390.2 D2, PR #400), building on the SLA dashboard calc from 02/07/2026.
