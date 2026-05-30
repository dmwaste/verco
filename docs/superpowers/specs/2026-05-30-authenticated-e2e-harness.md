# Authenticated E2E Harness — Design (VER-187 unblocker)

Generated 2026-05-30. Branch: `feature/ver-187-authenticated-e2e-harness`.
Status: DESIGN — implementation must be run on a Docker host (CI runners or a dev Mac); this
session has no Docker/local Supabase so the runtime pieces (session minting) can't be verified here.

## 1. Problem (why VER-187's flows can't be tested today)

`tests/e2e/` runs `pnpm dev` against a **remote** Supabase (CI secrets) and mocks the *browser's*
calls with `page.route`. That covers the public `/book` wizard (client components) and
unauthenticated redirects. It does **not** cover anything that is:

- **Server-rendered** — `/booking/[ref]`, `/admin/**`, `/field/**` pages fetch server-side, which
  `page.route` cannot intercept. The current admin/NCN/resident-detail specs **`test.skip()`** when
  the server returns no data (`ncn-detail.spec.ts:166-170,182-184,257-264`).
- **Auth/role-gated** — the proxy (`src/proxy.ts`) resolves role via a server-side `user_roles`
  query; RLS enforces PII exclusion. Testing "field role denied" needs a *real* authenticated
  field session, impossible past the app's **OTP-only** login in a scripted browser.

VER-187's four flows (MUD admin-on-behalf, admin edit/cancel-with-refund, resident NCN dispute,
field-role PII gates) are **all** in this server-gated category. Writing `page.route` specs for them
produces skip-guarded no-ops — fake green.

## 2. Goal

Authenticated, role-aware, seeded E2E: log a browser in as any of the 8 roles, against a Supabase
that has deterministic fixture data, so server components + proxy + RLS all run for real.

## 3. Architecture — local Supabase in CI (not a shared cloud project)

CI GitHub runners **have Docker**, so `supabase start` gives each run an **isolated, seeded** local
Supabase — no prod pollution, no cost, no migration-drift against a long-lived test project.

```
CI e2e-auth job:
  supabase start                      # local stack @ 127.0.0.1:54321 (Docker)
  supabase db reset                   # apply ALL migrations + run supabase/seed.sql
  seed test users + roles (script)    # admin/field/ranger/client-admin/resident/strata
  pnpm build && pnpm start            # prod-mode app against the local stack
  playwright test --project=auth      # global-setup mints sessions → storageState per role
```

Devs with Docker run the same locally. The existing **mocked** specs stay as-is (a separate
Playwright project, no auth) — they're fast and cover the public wizard.

## 4. The crux — minting a session past OTP (`tests/e2e/auth.setup.ts`)

GoTrue's **admin API** (service-role) issues a magic-link token without the user typing an OTP;
exchange it for a session, then save Playwright `storageState` per role.

```ts
// tests/e2e/auth.setup.ts — run as a Playwright "setup" project (one storageState file per role).
import { test as setup } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!          // 127.0.0.1:54321 in CI
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!         // local stack key
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const ROLES = ['contractor-admin', 'field', 'ranger', 'client-admin', 'resident', 'strata'] as const

for (const role of ROLES) {
  setup(`auth as ${role}`, async ({ page }) => {
    const email = `e2e-${role}@verco.test`
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })

    // 1. Generate a magic-link token (no email sent, no OTP typed).
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
    if (error) throw error
    const tokenHash = data.properties.hashed_token

    // 2. Exchange it for a session via the anon client (mirrors the real verifyOtp path).
    const anon = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } })
    const { data: sess, error: vErr } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash })
    if (vErr || !sess.session) throw vErr ?? new Error('no session')

    // 3. Inject the session into the browser the way supabase-js stores it, then save storageState.
    //    supabase-js (ssr) persists to a cookie `sb-<ref>-auth-token`; the exact key + chunking is
    //    the one detail to confirm on a running stack (read lib/supabase/client.ts cookie name).
    await page.context().addCookies([/* sb-<ref>-auth-token = base64(session) — confirm format */])
    await page.context().storageState({ path: `tests/e2e/.auth/${role}.json` })
  })
}
```

**The one thing to verify on a running stack:** how `@supabase/ssr` serialises the session
(cookie name `sb-<projectRef>-auth-token`, possibly chunked `.0/.1`, base64-`json`). Read
`src/lib/supabase/client.ts` + a real logged-in cookie to pin the format. This is *the* reason
this must be built where it can run — the rest is mechanical.

`playwright.config.ts`: add a `setup` project + an `auth` project that `dependencies: ['setup']`
and `use: { storageState: 'tests/e2e/.auth/<role>.json' }` per spec (or per-test `test.use`).

## 5. Seed fixtures (`supabase/seed.sql` additions, idempotent)

One D&M contractor + a `kwn` client + a collection area + eligible properties + services/rules +
**contacts + bookings in every state the flows need**, plus `user_roles` binding each `e2e-*` user:

| Fixture | For flow |
|---|---|
| booking `Confirmed` (paid) + `booking_payment paid` | admin edit/cancel-with-refund (VER-187 #2) |
| booking `Non-conformance` + an NCN `Issued` on it | resident NCN dispute (#3) |
| a MUD property + `strata_user_properties` binding the strata user | MUD admin-on-behalf (#1) |
| `user_roles` rows: each `e2e-<role>` → its role (+ client/area scope) | role gates (#4) |

Use stable UUIDs + `ON CONFLICT DO NOTHING` so `db reset` + re-seed is deterministic. Test users
created in `auth.setup.ts` (admin API) keyed by the same emails the `user_roles` seed references.

## 6. CI wiring (`.github/workflows/ci.yml` — new `e2e-auth` job, base==main like the mocked one)

```yaml
e2e-auth:
  if: github.base_ref == 'main'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4 ; uses: actions/setup-node@v4 (cache pnpm)
    - run: pnpm install --frozen-lockfile
    - run: pnpm exec playwright install --with-deps chromium
    - run: pnpm supabase start                 # Docker on the runner
    - run: pnpm supabase db reset               # migrations + seed.sql
    - run: pnpm build
    - run: pnpm start &                         # prod-mode app vs local stack
    - run: pnpm test:e2e -- --project=auth
      env:
        NEXT_PUBLIC_SUPABASE_URL: http://127.0.0.1:54321
        NEXT_PUBLIC_SUPABASE_ANON_KEY: <local anon key, from `supabase status`>
        SUPABASE_SERVICE_ROLE_KEY: <local service-role key>
```

(The local-stack keys are the well-known demo keys `supabase status` prints — safe to hardcode for
a local stack, they grant nothing beyond the ephemeral container.)

## 7. Migration of existing skip-guards + VER-187 flows (the payoff)

Once the harness lands, convert the skip-guarded specs to real authenticated tests and add VER-187:
1. **#4 role gates** — `storageState=field` → `/admin/**` redirects; field run-sheet returns **zero
   PII fields** (assert the contact columns are absent in the DOM/network). Highest security value, simplest.
2. **#3 NCN dispute** — `storageState=resident` → open the seeded NCN booking → Dispute → assert
   `Issued→Disputed`; `storageState=admin` → see it in the Disputed queue. RLS-enforced.
3. **#2 admin edit/cancel** — `storageState=admin` → edit the seeded paid booking inline; cancel →
   `process-refund` fires (assert the refund row / status).
4. **#1 MUD admin-on-behalf** — `storageState=strata`/admin → book on the seeded MUD property → NCN history.
Drop the `test.skip()` guards in `ncn-detail.spec.ts` once seeded data exists.

## 8. Risks / decisions

- **`supabase start` in CI adds ~60-90s** per run — acceptable; gated on `base==main` (release only),
  like the existing E2E job.
- **Session-cookie format** is the single must-verify-on-a-running-stack detail (§4).
- **Seed maintenance** — every schema change that the flows touch may need a seed update; keep the
  seed minimal (only what the specs assert).
- **Two Playwright projects** (`mocked` fast / `auth` seeded) keep the existing fast specs intact.

## 9. Effort / sequencing

1. (½ day) `auth.setup.ts` + cookie-format pin + `playwright.config` projects — **verify one role logs in** (the riskiest bit; do first on a Docker host).
2. (½ day) seed fixtures + `e2e-auth` CI job → green with the #4 role-gate spec.
3. (½ day each) convert #3, #2, #1 + drop the skip-guards.

**This session delivered the design only** (no Docker to run/iterate the runtime pieces). The
implementation is a clean pick-up on a Docker host — §4 is the one part that needs live iteration;
everything else is mechanical from this blueprint.
