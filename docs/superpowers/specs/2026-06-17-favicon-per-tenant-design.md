# Per-Tenant Favicons + New Default — Design

**Date:** 2026-06-17
**Branch:** `claude/brave-babbage-3b34af`
**Status:** Approved (brainstorming + eng review complete) — ready for implementation

## Problem / goal

Every tenant currently shows the Verco favicon in the browser tab. We want:
1. A **new default** Verco favicon (Verco "iD" mark — navy `#293F52`, green iD glyph, white dot), used on Verco-branded surfaces (admin, field, landing) and as the fallback for any client without a custom favicon.
2. A **per-client custom favicon** on that client's resident-facing pages, managed by admins like logos are today.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Split release**: PR-A (migration + new default + PWA set) → prod → PR-B (upload UI + serving + regen types) | Types-Freshness CI regenerates TS types from prod; a single PR referencing a not-yet-migrated column fails CI (CLAUDE.md §21) |
| D2 | **Refresh the `public/icons/` PWA set** (192/512/maskable/apple-touch) from the new mark | Field PWA + browser favicon stay visually consistent from one master; near-zero extra cost |
| D3 | **No `cache()` dedup** — `generateMetadata` runs its own `select('favicon_url')`; layout body's branding fetch untouched | Smallest, most explicit diff; two sub-ms PK lookups is negligible; avoids an unverified cross-pass cache-sharing assumption |
| D4 | **Keep the dedicated `favicon_url` column** (not derived from logo) | Tenants get a proper square mark; rectangular logos crop poorly as favicons |

### Folded-in fixes (from eng review + outside voice)
- **Segment guard (correctness bug):** `(public)/layout.tsx` also renders `/auth` on `admin.verco.au` / `field.verco.au`, where `x-client-id` is set from the `verco_admin_client` on-behalf cookie ([proxy.ts:337](../../src/proxy.ts)). `generateMetadata` MUST replicate the existing `isContractorHost` guard ([(public)/layout.tsx:63](../../src/app/(public)/layout.tsx)) and return the Verco default on those hosts — otherwise an on-behalf tenant's favicon leaks onto the admin login screen.
- **Helper hygiene:** `faviconToIcons(url)` takes the URL only (derives type internally); strip query/hash before extension check; constrain the upload `accept` to PNG/SVG.
- **Defensive fetch:** the favicon lookup returns `null` on a Supabase error so `generateMetadata` degrades to the default icon instead of throwing during metadata resolution.
- **PR hygiene:** PR-A is reviewed as a user-visible branding change (every tenant's default mark changes); PR-B's `git diff` on the type regen must show **only** `favicon_url` (ghost-release/types drift footgun).

## Architecture

```
REQUEST → resident page on tenant host
  │
proxy.ts ─ resolve client from host (or on-behalf cookie) ─► x-client-id header
  │
  ▼  app/(public)/layout.tsx
  ├─ generateMetadata()
  │     ├─ host is admin/field?  ─► return {} (Verco default)   ◄── segment guard (folded fix #1)
  │     ├─ no x-client-id?        ─► return {} (Verco default)
  │     └─ select('favicon_url') by client id (own tiny query, null-safe)
  │           └─ faviconToIcons(url) ─► { icons:{ icon:{ url, type } } } | undefined
  │                                          │
  │                              null/undefined ─► inherits root app/favicon.ico (NEW default)
  └─ PublicLayout() body  (unchanged branding fetch: name/logo/colours → CSS vars + nav)

admin / field / landing ─► default (guard or not under (public))
```

**Why metadata, not a file:** verified against Next.js source tests — config-based `metadata.icons` overrides the file-convention `favicon.ico` per-segment, so the default stays a static `app/favicon.ico` and the tenant override is emitted only where `generateMetadata` returns icons.

## Schema change (PR-A)

```sql
ALTER TABLE client ADD COLUMN favicon_url text;
```
- Nullable, additive. `client` is public-SELECT (`USING true`) → readable by the unauthenticated `(public)` fetch.
- Write coverage verified: `client_contractor_admin_update` / `client_client_admin_update` are row-level (`has_role(...) AND contractor_id = ...`), no column enumeration, no column-level GRANT → new column is write-covered, **no RLS change needed**.
- `client` has an `audit_trigger` → add `favicon_url: 'Favicon'` to `lib/audit/field-labels.ts` (PR-B).

## What already exists (reuse, rebuild nothing)

| Sub-problem | Reused |
|---|---|
| Resolve tenant per request | `proxy.ts` → `x-client-id` |
| Brand-asset upload | `handleUpload()` → `client-assets` bucket ([branding-tab.tsx](../../src/app/(admin)/admin/clients/[id]/tabs/branding-tab.tsx)); timestamped path auto-cache-busts |
| Persist field | `updateClient()` spreads `parsed.data` ([actions.ts](../../src/app/(admin)/admin/clients/actions.ts)) |
| Default favicon | `app/favicon.ico` file convention |
| Audit trail | `audit_trigger` on `client` |
| Test pattern | `src/__tests__/branding-defaults.test.ts` |

## Test plan

```
faviconToIcons(url)  [pure helper, 100% target]
  ├─ url null/empty     → undefined (inherit default)
  ├─ .svg (after strip) → { icon:{ url, type:'image/svg+xml' } }
  └─ .png/other         → { icon:{ url, type:'image/png' } }
generateMetadata()  [light test]
  ├─ admin/field host   → {} (Verco default)         ← guards the #1 bug
  ├─ no client id       → {}
  └─ favicon_url set    → icons present
Admin upload → manual QA (no existing branding-tab unit tests; 'use client')
E2E: none — single <link rel=icon> tag, not a 3+ component flow
```
No regression tests needed: `(public)` has no `generateMetadata` today — purely additive.

## Failure modes

| Path | Test? | Error handling | User sees | Critical? |
|---|---|---|---|---|
| Supabase error in favicon fetch | helper null branch | null-safe return → `{}` | Verco default | No |
| favicon_url set but asset 404 | n/a (browser) | implicit fallback | Verco default (not blank) | No |
| admin/field host not guarded | guard test | `isContractorHost` early return | Verco default (not tenant's) | **Fixed by guard** |
| non-png/svg uploaded | — | constrained `accept` + robust parse → png type; browser sniffs | correct icon | No |

## NOT in scope

- Per-tenant apple-touch / PWA / manifest icons — resident pages have no manifest (only the field app does); no resident-PWA demand.
- Server-side favicon resizing / multi-size generation — clients upload one square image; browsers handle a single PNG/SVG.
- `cache()` fetch dedup — rejected (D3); explicit separate query instead.
- Favicon derived from logo — rejected (D4); dedicated column.
- Refactor of the duplicated brand-colour normalization (`startsWith('#')…`) in `field/layout.tsx` + `(public)/layout.tsx` — pre-existing, optional follow-up TODO.

## Release sequencing

```
PR-A: migration (favicon_url) + new app/favicon.ico + refreshed public/icons/ PWA set
      → merge to develop → Dan cuts develop→main release → migration runs on prod
PR-B: regen types (verify diff = favicon_url only) + faviconToIcons + (public) generateMetadata
      + branding-tab UploadZone + updateClient schema + audit label + tests
```
Sequential by construction (PR-B depends on the column being live on prod). No worktree parallelization — small diff, hard phase dependency.

## Implementation tasks

Synthesized from the review. P1 blocks ship; P2 same branch; P3 follow-up.

**PR-A**
- [ ] **T1 (P1)** — db — `ALTER TABLE client ADD COLUMN favicon_url text;` (new migration). Verify: migration applies, no types change committed.
- [ ] **T2 (P1)** — assets — generate `src/app/favicon.ico` from the new square master; keep the master in `public/icons/`. Verify: tab shows new mark on a Verco-default page.
- [ ] **T3 (P1)** — assets — regenerate `public/icons/verco-{192,512,maskable-512}.png` + `apple-touch-icon.png` from the master. Verify: field app home-screen icon = new mark.

**PR-B** (after PR-A is live on prod)
- [ ] **T4 (P1)** — types — `pnpm supabase gen types …`; `git diff` must show only `favicon_url`. Verify: typecheck passes.
- [ ] **T5 (P1)** — `src/lib/branding/favicon.ts` — `faviconToIcons(url)` (strip query/hash, derive type) + `src/__tests__/favicon-icons.test.ts` (3 branches). Verify: `pnpm test` 100% on helper.
- [ ] **T6 (P1)** — `src/app/(public)/layout.tsx` — add `generateMetadata`: `isContractorHost` guard, read `x-client-id`, null-safe `select('favicon_url')`, call helper. Verify: tenant→custom; admin host→default.
- [ ] **T7 (P1)** — `branding-tab.tsx` — favicon `UploadZone` (accept png/svg, "square ≥512px" hint) + state + include in save.
- [ ] **T8 (P1)** — `clients/actions.ts` — add `favicon_url: z.string().nullable().optional()` to `updateClientSchema`.
- [ ] **T9 (P2)** — `lib/audit/field-labels.ts` — add `favicon_url: 'Favicon'`.
- [ ] **T10 (P2)** — manual QA — upload as contractor-admin → tenant tab icon; confirm admin/field `/auth` shows Verco default; confirm AuditTimeline shows "Favicon".

## Prerequisite

Dan to drop the new favicon **master** (square SVG or ≥512×512 PNG) into the repo so T2/T3 can generate `.ico` + the PWA sizes. (Pasted preview received; the source file is needed for generation.)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (not a strategy change) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | Claude subagent (Codex absent): 7 raised → 4 folded, 1 real bug corrected, 2 resolved by verification |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 7 issues, 0 critical gaps, 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (favicon swap — trivial visual) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **CODEX:** Codex CLI absent on this machine — outside voice ran as a Claude subagent. It caught one real correctness bug (#1: `(public)` `generateMetadata` would leak the on-behalf tenant favicon onto admin/field `/auth`), folded in as the `isContractorHost` guard. Helper-hygiene + PR-hygiene notes (#5/#6) also folded.
- **CROSS-MODEL:** 2 tensions decided by Dan — cut the `cache()` dedup in favour of a tiny explicit query (D3); keep the dedicated `favicon_url` column over deriving from logo (D4). One outside-voice claim (#4 favicon caching → support tickets) refuted by a code fact: `handleUpload` writes a timestamped path, so each upload yields a new URL and auto-busts the cache.
- **VERDICT:** ENG CLEARED — ready to implement as a split release (PR-A: migration + new default + PWA set → prod → PR-B: serving + upload UI + types).

NO UNRESOLVED DECISIONS
