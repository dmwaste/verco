# 0008 — Editing a paid booking's quantities is guarded against two people editing at once

- **Date:** 12/07/2026
- **Status:** Accepted

## Decision

When staff edit the item quantities on a paid booking inline, the save carries a snapshot of the items the editor was looking at. If the booking has changed since that page was loaded, the save is rejected and the editor re-prices from the fresh state. Pricing — including any refund owed for a reduction — is always recomputed on the server; nothing the browser sends can set a price or a refund amount.

## Why

Without the guard, two staff editing the same booking at once would each calculate a refund from the same starting point, and *both* refunds would fire — a double payout, with the booking left reflecting only the last save. Retry protection (from an earlier fix) stopped the same edit paying twice, but not two genuinely different simultaneous edits. The guard covers the whole window from viewing the page to writing the change, and it fails safe: a clash blocks the save rather than risking wrong money. Landed across the inline-editor releases (#380, hardened in #387.1 / PR #417, 10–12/07/2026).
