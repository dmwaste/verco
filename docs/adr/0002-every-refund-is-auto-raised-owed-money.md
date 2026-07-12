# 0002 — Every refund request is auto-raised owed money — no discretionary refunds

- **Date:** 12/07/2026
- **Status:** Accepted

## Decision

A refund request is only ever created automatically, by a change that has already been applied: a paid booking cancelled (by staff or by the resident), a paid booking's quantities reduced by staff, or a "contractor fault" ruling on a non-conformance / nothing-presented investigation. There is no button anywhere to issue an arbitrary refund.

## Why

Because the triggering change is already done, every row on the Refunds page is money genuinely owed to a resident — not a judgement call someone typed in. That gives Dan a clean rule: the Refunds queue is a list of debts, and approving is the normal action. It's also why *rejecting* a refund requires a typed confirmation — rejecting means keeping money a resident is owed, there is no way to re-raise the request, and the resident is never told. The list of valid triggers lives in one shared file (`src/lib/refunds/auto-raised.ts`) so the code that creates refunds and the page that classifies them can never drift apart.
