# Admin-subdomain cutover — design

**Date:** 2026-06-10
**Status:** Approved (design); ready for implementation plan
**Author:** Claude (project lead) with Dan Taylor

---

## 1. Problem

The "Admin" entry points on resident-facing pages link to a relative `/admin`, which keeps the operator surface on the *tenant* subdomain (e.g. `kwn.verco.au/admin`). We want the admin surface to live only on its own host, `admin.verco.au`, and we want the per-tenant `/admin` route retired.

## 2. Key finding — most of this is already built

The repo already contains a full contractor-host architecture:

- `admin.verco.au` / `field.verco.au` are first-class hosts with role guards, auth-host context (post-login redirect to `/admin` vs `/field`), and a tenant switcher (`verco_admin_client` cookie) that lets a `contractor-admin` span clients.
- The proxy already has **Branch B** ([`src/proxy.ts:135`](../../../src/proxy.ts)) that 308-redirects `{client}.verco.au/admin/*` → `admin.verco.au` and `{client}.verco.au/field/*` → `field.verco.au`.
- Branch B is gated behind `ADMIN_SUBDOMAIN_ENFORCED`, **defaulted off** with the comment "until DNS + Coolify aliases for the new hosts are live."

As of 2026-06-10 those hosts **are live**: `admin.verco.au` and `field.verco.au` both resolve to the Coolify host (`43.224.182.229`, same IP as the working `kwntest` tenant) and `https://admin.verco.au/api/health` returns `HTTP 200`.

So the task reduces to: (a) repoint the three admin buttons at the canonical admin host, and (b) flip the enforcement flag.

## 3. Decisions (locked with Dan)

| Decision | Choice |
|---|---|
| Retirement scope | **Full cutover** — repoint buttons *and* enable `ADMIN_SUBDOMAIN_ENFORCED` so the old paths 308-redirect. |
| Field subdomain | **Retire both** — use the existing shared flag; per-tenant `/field` redirects to `field.verco.au` at the same time. No flag-splitting. |

## 4. Design

### 4.1 Single source of truth for the admin origin

Add a pure helper `adminOrigin(currentHost: string): string` to [`src/lib/proxy/hostnames.ts`](../../../src/lib/proxy/hostnames.ts), beside the existing `isAdminHostname` / `toAdminHostname`:

- Dev host (`*.localhost` / `localhost`, optional `:port`) → `http://admin.localhost[:port]` (preserve the port).
- Everything else (prod `*.verco.au` **and** any custom domain) → the **constant** `https://admin.verco.au`.

Rationale: the admin surface is a *fixed* host, not a per-tenant derivation. `toAdminHostname()` rewrites only the first DNS segment, which is correct for `*.verco.au` but wrong for a council on a custom domain (`bins.kwinana.wa.gov.au` → `admin.kwinana.wa.gov.au` ✗). `adminOrigin()` returns the constant so custom-domain tenants resolve to the real admin host. `ADMIN_HOSTNAME_PROD` ('admin.verco.au') is reused as the constant.

### 4.2 Repoint the three admin entry points

| File | Current | Change |
|---|---|---|
| [`src/app/(public)/layout.tsx`](../../../src/app/(public)/layout.tsx) (~L110/L117) | passes `showAdminLink` only | compute `adminUrl = adminOrigin(host)` from `headers()` and pass `adminUrl` to `<PublicNav>` and `<MobileBottomNav>` |
| [`src/components/public/public-nav.tsx`](../../../src/components/public/public-nav.tsx) (L55) | `<Link href="/admin">` | accept `adminUrl` prop; render `<a href={adminUrl}>` (cross-origin = full navigation, not a client-side `<Link>`) |
| [`src/components/public/mobile-bottom-nav.tsx`](../../../src/components/public/mobile-bottom-nav.tsx) (L47) | Admin tab `href: '/admin'` as `<Link>` | accept `adminUrl` prop; the Admin tab renders as a plain `<a href={adminUrl}>` while the other tabs stay as `<Link>` |
| [`src/app/landing/page.tsx`](../../../src/app/landing/page.tsx) (L62) | `adminUrl = \`${tenantUrl}/admin\`` (per-tenant custom_domain) | `adminUrl` = constant admin origin; every council card's "Staff sign in" points at the one admin host |

The buttons target `…/admin` (not the bare host) so the proxy lands the user on the operator surface directly (and bounces to `/auth` if unauthenticated).

Note: `mobile-bottom-nav.tsx` is a `'use client'` component but takes `adminUrl` as a prop computed server-side in the layout — so no client-side env or `window.location` access is needed.

### 4.3 Enable enforcement (the retirement)

Set `ADMIN_SUBDOMAIN_ENFORCED=true`. The proxy's Branch B then 308-redirects both `{client}.verco.au/admin/*` and `{client}.verco.au/field/*` to their dedicated hosts, preserving path + query.

This is a **server-runtime** env var (not `NEXT_PUBLIC`), so it is set on Coolify and picked up on container restart — **no rebuild**. `.env.example` already carries the commented `# ADMIN_SUBDOMAIN_ENFORCED=true` line.

**The existing Branch-B redirect code is used unchanged.** It rewrites the first DNS segment (`toAdminHostname` / `toFieldHostname`), which is correct for every current tenant (all on `*.verco.au`). We deliberately do **not** refactor it to use the constant resolver — there are no custom-domain councils today, and the buttons (the primary entry point) already use the constant. See §6.

## 5. Consequences (accepted)

- **One-time staff re-login** on the new host. Auth cookies are host-only (no `Domain=.verco.au`), so a staff member logged in on a tenant subdomain who clicks Admin hits `admin.verco.au` with no session → OTP re-login. Blast radius is small (Kwinana + VV UAT staff only). Sharing sessions via a `.verco.au` cookie domain is explicitly **out of scope** (larger auth/security change).
- **Residents unaffected.** Only `/admin` and `/field` redirect; `/book`, `/dashboard`, `/booking`, `/survey` stay on the tenant subdomain.
- The `verco_admin_client` switcher cookie is host-only and re-defaults harmlessly on the admin host (first accessible client) until the user re-selects.

## 6. Out of scope

- Sharing auth sessions across subdomains via a `Domain=.verco.au` cookie.
- Any redesign of the landing page beyond repointing the existing buttons (multiple identical "Staff sign in" buttons all pointing at one admin host is acceptable; YAGNI on consolidation).
- Splitting the enforcement flag into separate admin/field flags (Dan chose to retire both with the shared flag).
- **Refactoring the proxy Branch-B redirect to the constant admin/field host** (eng-review D1). The segment-rewrite is correct for all current `*.verco.au` tenants; the admin host is always `admin.verco.au` even for a future custom-domain tenant, but no council uses a custom domain today. Revisit only when the first custom-domain tenant onboards.
- **A `proxy()` integration test harness** (eng-review D2). None exists; the redirect is four trivial flag-gated lines. The new resolver is unit-tested directly; the 308 itself is verified by rollout smoke (§9 step 4).

## 7. Testing

- **Unit** — `adminOrigin()` in the existing [`src/__tests__/proxy-hostnames.test.ts`](../../../src/__tests__/proxy-hostnames.test.ts): prod `*.verco.au` host → `https://admin.verco.au`; custom domain → `https://admin.verco.au`; `kwntest.localhost:3000` → `http://admin.localhost:3000`; bare `localhost:3000` → `http://admin.localhost:3000`. This is the only new automated test.
- **The 308 redirect itself** is verified by rollout smoke (§9 step 4), not a new proxy harness — see §6.
- **Typecheck + lint + build** (`pnpm tsc`, `pnpm lint`, `pnpm build`) green before PR.

## 8. Docs

- CLAUDE.md §10 (proxy): note that `/admin` and `/field` are served only on their own hosts once enforcement is on.
- Memory `uat-subdomains.md`: record that admin/field now live on `admin.verco.au` / `field.verco.au` and the per-tenant routes 308-redirect.

## 9. Rollout / rollback

1. **Code**: PR → `develop` → batched to `main`; Coolify deploys on push-to-main.
2. **Verify** the deployed SHA via `https://admin.verco.au/api/health` before flipping.
3. **Flip**: set `ADMIN_SUBDOMAIN_ENFORCED=true` on Coolify, restart the container.
4. **Smoke**: tenant `/admin` 308s to `admin.verco.au`; resident pages' Admin button lands on `admin.verco.au/admin`; field PWA reachable on `field.verco.au`.

**Order constraint:** flip the flag only *after* the repointed code is live, so live buttons and the redirect agree (otherwise a harmless but messy double-hop).

**Rollback:** unset `ADMIN_SUBDOMAIN_ENFORCED` and restart. Buttons keep pointing at `admin.verco.au` (which is live and correct), the per-tenant redirect simply stops. Fully reversible; no code revert required.

## GSTACK REVIEW REPORT

Eng review (`/plan-eng-review`) run 2026-06-10. Scope was **reduced** mid-review at Dan's direction — the proxy-redirect refactor and a `proxy()` test harness were cut as over-engineering.

| Section | Result |
|---|---|
| Step 0 — Scope | Reduced. Code change is 1 helper + 4 edits; everything else reuses existing contractor-host machinery. Complexity gate not triggered. |
| Architecture | D1: proxy Branch-B segment-rewrite is wrong for a future custom-domain tenant → **deferred** (no custom-domain councils; admin host is always `admin.verco.au`; buttons already use the constant). Out of scope §6. |
| Code quality | No separate findings — the one DRY concern is resolved by the single shared resolver. |
| Tests | One new automated test: `adminOrigin()` unit cases (prod/custom/dev/bare-localhost). The 308 verified by rollout smoke. D2 harness **deferred**. |
| Performance | No issues (pure string work + one extra header read already present in the layout). |
| Failure modes | No critical gap (no failure that is untested **and** unhandled **and** silent). Forced re-login is handled + accepted; custom-domain redirect is not reachable today. |

**Decisions:** D1 → defer proxy refactor (out of scope). D2 → helper unit tests + rollout smoke (no harness).
**Parallelization:** Sequential — single workstream, all edits in `src/`. No parallel lanes.
**UNRESOLVED:** none.
**VERDICT:** ENG CLEARED — ready to implement.
