# CLAUDE.md — Verco v2

This file is read automatically at the start of every Claude Code session.
Do not delete or rename it. Keep it up to date as decisions change.

---

## Working Mode — Project Lead

You are the project lead on this repo. Take ownership of next steps; don't hand back work you can do yourself.

- **Default after a self-contained change:** commit → push → PR. Don't enumerate "commit / run / both?" when the right answer is "do all of it".
- **Verify locally before reporting back:** tests, typecheck, smoke runs. Dan shouldn't have to ask "did you run them?".
- **Bundle obvious follow-ups** (env.example, type regen, CLAUDE.md update for a new pattern) into the same change — not as TODOs handed back to Dan.
- **Ask Dan only when:**
  - Real money is about to move (Dan kicks off paid runs himself, not you)
  - Action is hard to reverse (force push, schema drop, prod data delete, external comms)
  - It's a strategy / taste / branding call genuinely needing his judgement
  - You're blocked on context only he has (credential, stakeholder commitment, external decision)
- **Frame end-of-turn updates as "what shipped + what's next"** — not "which option would you like?".

---

## 1. What This Project Is

**Verco** is a white-labelled, multi-tenant SaaS platform for managing residential bulk verge collection bookings on behalf of WA local governments.

- **Operator:** D&M Waste Management (Safety Bay WA)
- **Companion app:** DM-Ops (separate repo, separate Supabase project)
- **Full spec:** See `docs/VERCO_V2_PRD.md` and `docs/VERCO_V2_TECH_SPEC.md`

---

## 2. Stack

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router) | Server components, server actions, proxy |
| Language | TypeScript 5 — strict mode ON | `strict: true` in tsconfig — no exceptions |
| Styling | Tailwind CSS 4 | Utility classes preferred; inline styles for layout where Tailwind isn't rendering |
| UI | shadcn/ui (Radix primitives) | `components/ui/` — never edit these files |
| Forms | react-hook-form + zod | All forms use zod schemas for validation |
| Server state | TanStack Query v5 | All async data fetching |
| Backend | Supabase (separate AU project) | ap-southeast-2 |
| Auth | Supabase Auth — email OTP only | No passwords, no OAuth |
| Payments | Stripe | Single D&M account |
| Package manager | pnpm | Never use npm or yarn |
| Testing | Vitest + Testing Library + Playwright | Unit + E2E |
| Fonts | Poppins + DM Sans via next/font/google | `--font-poppins` (headings), `--font-dm-sans` (body/sans) |
| Maps | Leaflet via `dynamic(() => ..., { ssr: false })` | OpenStreetMap tiles; coerce Postgres `numeric` → `Number()` |
| Hosting | Coolify on BinaryLane | Node container — no edge runtime |

---

## 3. Entity Hierarchy

Always think in this hierarchy. Every feature touches one or more of these levels:

```
Contractor          e.g. D&M Waste Management
  └── Client        e.g. City of Kwinana, WMRC (Verge Valet)
        └── Sub-client   e.g. City of Cockburn (COT) under WMRC — nullable
              └── Collection Area   e.g. KWN-1, VV-COT — the atomic booking unit
                    └── Eligible Property   e.g. 23 Leda Blvd, Wellard
                          └── Booking

Category (Bulk / Ancillary / Illegal Dumping)
  └── Service (General, Green, Mattress, E-Waste, Whitegoods)
```

**Schema naming:** `category` = capacity grouping (Bulk/Ancillary/ID, `code` column). `service` = individual types (FK → category). `allocation_rules` = per area per category. `service_rules` = per area per service. `booking_item.service_id` → FK to `service` (not `service_type`).

**Key rules:** Portal is branded at **client** level. Address lookup resolves to a **collection area** — never ask resident to select one. Sub-clients are optional. `dm_job_code` on `collection_area` is DM-Ops sync metadata only.

---

## 4. Role Model

Eight roles. Scope is enforced at the DB level via RLS — never rely on frontend-only checks.

| Role | Tier | Scope |
|---|---|---|
| `contractor-admin` | Contractor | All clients under their contractor |
| `contractor-staff` | Contractor | All clients — limited write |
| `field` | Contractor | Run sheet + closeout — **zero PII** |
| `client-admin` | Client | Own client; optionally narrowed to one **sub-client** via `user_roles.sub_client_id` (NULL = whole client) |
| `client-staff` | Client | Own client + sub-clients — limited write; same sub-client narrowing as client-admin |
| `ranger` | Client | Own areas — **zero PII**; same sub-client narrowing |
| `resident` | End user | Own bookings only |
| `strata` | End user | Authorised MUD properties only |

**Sub-client scoping (VER-216):** Client-tier roles can be narrowed to a single sub-client (e.g. a COT-only `client-admin` under Verge Valet sees zero MOS bookings). `user_roles.sub_client_id IS NULL` keeps the historical "whole client" scope. Helpers: `current_user_sub_client_id()`, `user_sub_client_allows_area(area_id)`, `user_sub_client_allows_booking(booking_id)` — all SECURITY DEFINER STABLE. See memory `sub-client-scoping-pattern.md` for the full helper map + which tables are scoped vs deliberately skipped (public-SELECT tables, `booking_item` via transitive scope).

**PII rule — absolute, no exceptions:** `field` and `ranger` receive zero contact fields (`first_name`, `last_name`, `full_name`, `email`, `mobile_e164`); structural exclusion in `(field)/field/run-sheet/page.tsx`, not just RLS. Never use `is_contractor_user()` in RLS policies gating PII — it includes `field`. Use `current_user_role() IN ('contractor-admin', 'contractor-staff')` instead.

**Privacy rule:** Admin pages exclude `resident` from user management queries/dropdowns. `strata` users ARE admin-managed (must be bound to MUD properties by an admin); full resident list never exposed.

---

## 5. Supabase Client Usage

Two clients exist — `lib/supabase/server.ts` (server) and `lib/supabase/client.ts` (browser). Read the source files for implementation.

- **Always use the anon key** in both clients — RLS does the access control
- **Never use the service role key** in any client-side or server component code — it must stay in `supabase/functions/`
- Use **server client** in: `app/**/page.tsx`, `app/**/layout.tsx`, `app/api/**/route.ts`, server actions (`'use server'`)
- Use **browser client** in: files with `'use client'` directive, custom hooks in `hooks/`

---

## 6. Pricing Engine — Hard Rules

```
NEVER accept unit_price_cents from the client.
NEVER calculate price in a client component.
NEVER skip the server-side price recalculation on booking creation.
```

**Flow:** Client calls `calculate-price` EF → displays result → on confirm, `create-booking` EF **re-runs** `calculatePrice` internally (never trusts client price) → rejects if price differs.

### Dual-limit free unit calculation

A unit becomes paid (extra) when EITHER limit is exhausted:

```
category_remaining = allocation_rules.max_collections - FY usage across ALL services in that category
service_remaining  = service_rules.max_collections - FY usage for THIS specific service
free_units         = MIN(requested_qty, category_remaining, service_remaining)
paid_units         = requested_qty - free_units
```

**Only free_units consume category budget** — paid units do not reduce the remaining count.

Authoritative implementation: `supabase/functions/_shared/pricing.ts`. Node extraction: `src/lib/pricing/calculate.ts` (tested with Vitest, keep in sync). Client preview in `services-form.tsx` mirrors for display only.

---

## 7. Booking State Machine — Hard Rules

Valid transitions only. The DB trigger `enforce_booking_state_transition` will reject invalid transitions — but never try to force one from application code either.

```
(initial)       → Confirmed       (create-booking EF — free path)
(initial)       → Pending Payment (create-booking EF — paid path)
Pending Payment → Confirmed       (Stripe webhook on payment success — auto-confirm)
Pending Payment → Submitted       (legacy — no production code path writes it)
Pending Payment → Cancelled       (handle-expired-payments cron)
Submitted       → Confirmed       (admin "Confirm" button — safety net for legacy bookings)
Submitted       → Cancelled       (any staff role or resident pre-cutoff)
Confirmed       → Scheduled       (cron: 3:25pm AWST daily — never manual)
Confirmed       → Cancelled       (any staff role or resident pre-cutoff)
Scheduled       → Completed       (field role only)
Scheduled       → Non-conformance (field role only)
Scheduled       → Nothing Presented (field role only)
Scheduled       → Cancelled       (any staff role pre-cutoff)
Non-conformance → Rebooked        (client-admin, contractor-*)
Nothing Presented → Rebooked      (client-admin, contractor-*)
```

**Bookings skip Submitted by design (auto-confirm, 2026-05-18).** Free bookings land directly in Confirmed; paid bookings flip Pending Payment → Confirmed on Stripe success. The Submitted enum value and `Submitted → Confirmed` transition stay as a safety net for any legacy row or future re-introduced manual gate.

**Never directly set `status = 'Scheduled'` from application code.** The cron handles this.

**Cancellation cutoff:** 3:30pm AWST the day prior to collection. The DB trigger `enforce_cancellation_cutoff` rejects violations — but always check `can_cancel_booking()` RPC before showing the cancel UI.

### NCN/NP State Machine

Non-conformance notices and nothing presented records follow a separate state flow from bookings:

```
Issued → Disputed         (resident, within 14 days)
Issued → Closed           (auto-close cron, after 14 days with no dispute)
Disputed → Under Review   (staff)
Under Review → Resolved   (staff — NCN)
Under Review → Rescheduled (staff — NCN with rebook)
Under Review → Rebooked   (staff — NP)
```

- Default status is `Issued` (not `Open` — `Open` enum value kept but unused)
- Staff can only investigate/resolve `Disputed` or `Under Review` notices — never `Issued`
- Resident dispute is RLS-enforced: policies constrain to `Issued → Disputed` on own bookings only

---

## 8. TypeScript Conventions

- **Strict mode always on** — `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns` in tsconfig
- **Never use `any`** — always use generated types from `lib/supabase/types.ts`
- **Regenerate types after every migration** — see §18 Commands
- **Zod schemas for all external inputs** — every API route, server action, and Edge Function
- **Result pattern** — use `Result<T, E = string>` (`{ ok: true, data }` | `{ ok: false, error }`) — never throw across async boundaries

---

## 9. File & Folder Conventions

### Naming
- **Files:** `kebab-case.tsx` / `kebab-case.ts`
- **Components:** `PascalCase` named export
- **Hooks:** `useCamelCase` — always prefix with `use`
- **Server actions:** `camelCase` in `app/**/actions.ts`
- **Utilities:** `camelCase` in `lib/utils/`

### Component co-location
Keep components close to where they're used. Only promote to `components/` when used in 3+ places. Co-locate single-use components and hooks in the same directory as their page.

### Server vs. client components
Default to **server components**. Add `'use client'` only when you need `useState`/`useReducer`, `useEffect`, browser APIs, or event handlers that can't be server actions.

### Route groups
```
app/
  (public)/     ← resident-facing pages
  (admin)/      ← client-admin, client-staff, contractor roles
  (field)/      ← field + ranger roles (mobile PWA)
```

Each group has its own `layout.tsx` with appropriate auth + role guards.

---

## 10. Proxy (was Middleware)

`src/proxy.ts` (renamed from `middleware.ts` for Next.js 16) runs on every request. Exported function is `proxy`, not `middleware`. It does three things in order:

1. **Resolve client from hostname** — looks up `client` table by `slug` or `custom_domain`. In development (`NODE_ENV=development` + localhost), bypasses slug matching and fetches the first active client ordered by `created_at`.
2. **Validate session** — refreshes Supabase auth token if needed
3. **Route guards** — redirects unauthenticated or wrong-role users

**Route guards:** `/field/*` → field/ranger. `/admin/*` → staff roles. `/dashboard` → authenticated. `/book/*` and `/survey/*` → public.

The resolved `client_id`, `client_slug`, and `contractor_id` are set as **request** headers (`x-client-id`, `x-client-slug`, `x-contractor-id`) via `NextResponse.next({ request: { headers } })` — NOT response headers. Read via `headers()` in server components and actions. Never re-query for these in downstream code.

**Root host (`verco.au` / `www.verco.au` / dev alias `root.localhost`)** is Branch Z: www 308s to the apex (literal Location, never derived from inbound headers); `/robots.txt` passes through to `public/`; a `/b/<ref>` miss rewrites to `/landing` with `x-verco-bref-miss: 1` (recovery banner). Inbound proxy-owned headers (`x-verco-*`, `x-client-*`, `x-contractor-id`) are stripped on NON-root branches only — never globally, because the `/landing` rewrite re-enters the proxy carrying headers the first pass legitimately set. Helper + header constants live in `lib/proxy/hostnames.ts`. The landing page is dev/test-reachable only via `http://root.localhost:3000` (header forging is stripped; the page 404s without `x-verco-root`).

**Admin/field surfaces live on their own hosts** (`admin.verco.au` / `field.verco.au`), never per-tenant. The "Admin" links on resident pages point at the canonical admin host via `adminOrigin(host)` in `lib/proxy/hostnames.ts` (prod → fixed `https://admin.verco.au` regardless of tenant, even a custom domain; dev → `http://admin.localhost:PORT`) — NOT a per-tenant segment rewrite. When `ADMIN_SUBDOMAIN_ENFORCED=true` (server-runtime Coolify env), the proxy 308-redirects `{tenant}/admin/*` and `{tenant}/field/*` to those hosts. Auth cookies are host-only, so moving a tenant-subdomain session to the admin host forces a one-time OTP re-login.

---

## 11. Edge Functions

All Edge Functions live in `supabase/functions/`. Each function is a single `index.ts` file. Shared code in `_shared/`. See `docs/VERCO_V2_TECH_SPEC.md` §10 for contracts. Follow the pattern of existing functions (auth → parse → validate → execute).

### Rules
- **Public route functions** (e.g. `calculate-price`, `google-places-proxy`) must accept anon key only — do not require `auth.getUser()` to succeed
- **Service role** only for: `nightly-sync-to-dm-ops`, `stripe-webhook`, `audit_log` writes, batch admin ops — document why with a comment
- **Error handling** — catch blocks must return `err.message`, not generic strings. Include `rpcError.message` on RPC failures
- **Calling from Next.js** — use direct `fetch()` with explicit URL/headers, not `supabase.functions.invoke()` (unreliable in SSR)
- **Cron EFs** — return HTTP 500 when any per-row work fails (pg_cron only sees HTTP status; a 200 hides partial failures). Wrap `cron.schedule` migrations in `DO $$ IF EXISTS cron.unschedule $$ END` so they can be re-applied

---

## 12. RLS — What Claude Code Must Know

RLS is the primary security layer. Application code is defence-in-depth, not the first line of defence. See `docs/VERCO_V2_TECH_SPEC.md` §6 for full policy details and helper function reference.

### Rules
- **New tables:** enable RLS immediately, write policies before application code, default to deny
- **Never use service role to bypass RLS** in application code — and never filter by `client_id` manually (RLS handles scoping)
- **Public SELECT tables** (no auth required): `client`, `collection_area`, `eligible_properties`, `collection_date`, `category`, `service`, `service_rules`, `allocation_rules`, `financial_year`
- **Cross-table RLS policies** that cause recursion: wrap lookups in `SECURITY DEFINER` functions (see `current_user_contact_id_by_email()` for pattern)

---

## 13. Capacity — Concurrency Rules

**Never check capacity in application code and then insert separately.** Always use the `create_booking_with_capacity_check` RPC — it wraps capacity check + insert in a serialisable transaction with a Postgres advisory lock. See `docs/VERCO_V2_TECH_SPEC.md` §9 for details.

---

## 14. Testing Requirements

### Coverage targets
- Pricing engine (`lib/pricing/calculate.ts`): **100%** — no exceptions
- State machine transitions: **100%**
- RLS policies: smoke test per role per table
- E2E booking flows: free booking, paid booking, mixed cart

### Every new feature requires
1. Unit tests for business logic (`src/__tests__/`)
2. E2E test for user-facing flows (`tests/e2e/`)
3. RLS test if a new table or policy is added

---

## 15. What Not To Build

These are explicitly out of scope for v2. If a task seems to require one of these, stop and check with Dan before proceeding.

| Out of scope | Why |
|---|---|
| OptimoRoute Driver app usage / status feedback to OptimoRoute | OR is **plan-only** (decision 10/06/2026): Verco pushes orders at T-3 hard close, ops plan in OR web, Verco pulls sequences back. Crews work in Verco's field UI; closeout never flows back to OR. (Stops carry their OR reference on `collection_stop.external_order_ref`; the old `booking.optimo_stop_id` placeholder was dropped 02/07/2026.) |
| Stripe Connect | Future — `client_id` on payments is prep only |
| Cross-client benchmarking in reports | Explicitly excluded — tenant data only |
| Email template management UI | Templates are code-defined in Edge Functions |
| Xero integration | Lives in DM-Ops only |
| Any DM-Ops tables | `docket`, `timesheet`, `employee`, `crew`, `asset`, `tender`, `purchase_order`, `invoice` — not in this schema |
| `dm-admin` / `dm-staff` / `dm-field` roles | These are DM-Ops roles — Verco v2 does not have them |
| Strata self-service booking portal | Data layer (role, junction, RLS, admin provisioning) is wired — UI deliberately deferred. Admin-on-behalf is the only MUD booking path today |

---

## 16. Environment Variables

See `docs/VERCO_V2_TECH_SPEC.md` §16 for full list. Key rules:
- **`NEXT_PUBLIC_*`** — safe for browser (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `STRIPE_PUBLISHABLE_KEY`)
- **`SUPABASE_SERVICE_ROLE_KEY`** — Edge Functions only. **If you need it in `app/` — stop. You are doing something wrong.**
- **Edge Function secrets** — set in Supabase dashboard, never in `.env`

---

## 17. Git Conventions

- **Branches:** `feature/`, `fix/`, `chore/` prefixes. **Commits:** Conventional (`feat:`, `fix:`, `chore:`, `test:`).
- **Base branch is `develop`, not `main`.** Every PR targets `develop` — `gh pr create --base develop ...`. `main` is the production branch and updates only via batched `develop → main` PRs that Dan cuts when ready to deploy. The Coolify deploy fires on push-to-main, so this gives us one deploy per batch instead of one per PR.
- **Hotfix exception:** if production is broken and waiting on a develop-batch isn't acceptable, branch off `main`, fix, PR straight to `main` with explicit "hotfix" in the title. Then immediately back-merge `main → develop` so develop doesn't drift.
- **Never commit:** `.env*`, `supabase/.temp/`

---

## 18. Commands Reference

```bash
pnpm dev                                                 # Next.js dev server
pnpm test  |  pnpm test:coverage  |  pnpm test:e2e       # Vitest + Playwright
pnpm build  |  pnpm start                                # production build
pnpm supabase migration new <name>                       # new migration
pnpm supabase db push                                    # push migrations
pnpm supabase functions deploy <name> --no-verify-jwt    # deploy EF
pnpm supabase gen types typescript --project-id tfddjmplcizfirxqhotv > src/lib/supabase/types.ts
# After type gen, strip any CLI warnings the command appends to the file.
```

---

## 19. Key Documents

| Document | Location | Read when |
|---|---|---|
| PRD | `docs/VERCO_V2_PRD.md` | Unclear on scope, user flows, or business rules |
| TECH_SPEC | `docs/VERCO_V2_TECH_SPEC.md` | Unclear on schema, RLS, Edge Function contracts |
| Supabase types | `lib/supabase/types.ts` | Always — generated, never hand-edit |

---

## 20. Red Lines

These are absolute. If a task requires crossing one, stop and flag it.

1. **Never set `unit_price_cents` from client input** — server-side calculation only, always re-validated on booking creation
2. **Never return any contact PII (name fields, email, mobile) to `field` or `ranger` roles** — structural exclusion, not a UI hide. See §4 for the full list.
3. **Never use service role key in `app/` code** — Edge Functions only
4. **Never skip the advisory lock on capacity-critical writes** — always use `create_booking_with_capacity_check` RPC
5. **Never directly set `booking.status = 'Scheduled'`** — the cron owns this transition
6. **Never write to DM-Ops tables from Verco application code** — only `nightly-sync-to-dm-ops` Edge Function touches DM-Ops
7. **Never bypass RLS with application-level filtering as a substitute** — RLS is the contract, not a fallback

---

## 21. Patterns & Gotchas

### Audit trail on new tables — attach `audit_trigger_fn()` AFTER INSERT/UPDATE/DELETE, add cols to `lib/audit/field-labels.ts`, render `<AuditTimeline>` (client pages need a server-action wrapper — see `collection-dates/actions.ts`).

### RLS on new columns — check UPDATE policies exist; writes silently fail without them.

### White-label colours — CSS vars, not hex. Public/field use `--brand` / `--brand-accent` / `--brand-foreground` + `-light`/`-hover`/`-dark` (admin exempt). `text-white` silently fails under Tailwind v4 + Turbopack — use `--brand-foreground` (defaults `#FFFFFF`) with inline `style={{ color }}` fallback (see `VercoButton`).

### Admin list-page primitives + status tokens (design-debt batch 03/07/2026) — admin list surfaces compose `PageHeader` / `FilterBar` / `SearchInput` / `FilterSelect` / `Th` / `Pagination` from `components/admin/` and `<StatusBadge entity status>` (`components/status-badge.tsx`) — never re-type the header/filter/pill/pagination markup inline. Status colours come ONLY from the semantic pairs in `lib/ui/status-styles.ts` (backed by the `--color-status-{success,warn,error,info}` + `-bg` tokens in globals.css); 11px type is `text-caption` (no arbitrary `text-[11px]`); keyboard focus rings come from the `.admin-surface :focus-visible` base rule — any `outline-none` must pair with an explicit focus affordance. Admin `<table>`s carry `tabular-nums` on the table element.

### EFs that access PII accept dual auth (per §20 Red Line #3) — server actions MUST NOT use service role. EFs needing PII (`send-notification`, etc.) accept EITHER a service-role bearer (EF→EF) OR a user JWT whose `current_user_role()` is in a permitted set. Internal loads use service role; the user role gates the trigger.

### Notification module — use `templates/template-helpers.ts` + `invokeSendNotification` from `src/lib/notifications/invoke.ts`. Resume-by-log-id only for `RESUMABLE_TYPES` in `dispatch.ts`. `_shared/`↔`src/lib` mirror pairs (dispatch, health, templates) are kept in sync by `scripts/sync-mirrors.sh` (`_shared/` is source of truth; the script strips Deno `.ts` import extensions). A NEW mirror pair must be registered in that script — its CI `--check` only guards listed files, so an unregistered mirror drifts silently.

### Public-SELECT RLS (`USING(true)`) doesn't tenant-scope — filter in app. `eligible_properties`, `collection_area`, `collection_date`, `client` etc. are cross-tenant readable for the unauthenticated `/book` flow. Server pages must read `x-client-id` from `headers()`, pass `clientId` to client components, and queries must join via embedded `!inner` FK + `.eq('<fk>.client_id', clientId)`. See `book/page.tsx` + `book/address-form.tsx`. Same trap for **which client an admin may act as**: validate the switcher cookie / `x-client-id` against `accessible_client_ids()` (SETOF; `id IN (SELECT accessible_client_ids())` or fetch-then-`.in`), NEVER re-query the public-SELECT `client` table by `is_active` alone — that validates any active client id → cross-tenant switcher leak (P1, fixed in `lib/admin/current-client.ts`, #275).

### `NEXT_PUBLIC_*` vars are baked at build time — inlined via Docker build-args (`deploy.yml`); Coolify runtime env is a no-op. New vars: add to `.env.example`, GitHub secrets, `deploy.yml` build-arg, and Dockerfile `ENV`.

### Shape consistency — DB column changes + EF response envelopes need the migration → EFs-with-back-compat-shim → Coolify → strip-shim sequence; EF responses emit documented fields on every path (success, no-op, error) — missing-field defaults belong in the EF, not the parser.

### `contacts.full_name` is `GENERATED ALWAYS AS STORED` — read-only. `INSERT`/`UPDATE` on `full_name` fails. Forms must capture `first_name` + `last_name` as separate required fields; select `full_name` for display only.

### Generated `STORED` columns over NOT NULL inputs need explicit `ALTER COLUMN ... SET NOT NULL` — Supabase CLI infers nullability from metadata, not the expression; without it regen'd TS is `string | null`.

### PostgREST `.or()` + embedded-select gotchas — (1) multi-FK embeds (`select('parent, related(child)')`) silently return empty inner for authed users once `related` accumulates FKs (service-role works); fix: split-query+stitch or `related!fk_name(col)`. (2) `.or()` can't filter parents by columns on a nullable LEFT-joined table — pre-fetch ids + `.in(...)`. (3) any `.or()` value with a comma (or other PostgREST-reserved char) must be double-quoted — a bare comma is read as the separator BETWEEN conditions → `PGRST100` 400 swallowed into `data:null`; address/search strings always hit this. Quote each value (`col.ilike."val, x"`, escape inner `"`/`\`). Helpers: `buildEligibleOrFilter` (booking) + `buildSearchOrFilter` (admin search, `lib/search/or-filter.ts`). Canonical: `admin/bookings/bookings-list-client.tsx`.

### Notification idempotency keys on `(booking_id, type, channel)`, not `(booking_id, type)` — email + SMS must succeed independently. Dispatcher's `isAlreadySent` takes a channel arg; new channels (push, voice) follow the same rule.

### Markdown rendering (FAQ answers) — `components/faq-answer.tsx` is deliberately directive-free: imported by an RSC it renders server-side (react-markdown stays OUT of the public bundle; nodes pass to client components as props), imported under `'use client'` it renders client-side (admin live preview). No `rehype-raw` EVER — answers are admin-authored multi-tenant content on public pages; raw HTML must stay inert. react-markdown's default URL transform strips `tel:` (allows http/https/mailto) — `urlTransform` extends it for tel: links. Tenant FAQ content seed: `scripts/load-faqs.mjs` (dry-run by default; `--apply` is gated on the renderer release being live — see script header).

### `useState(searchParams.get(...))` doesn't sync on same-path soft navigation — `router.push` to the same path doesn't remount, so init runs only once. Fix: `useEffect(() => setX(searchParams.get('x') ?? ''), [searchParams])`. Pattern in `admin/bookings/bookings-list-client.tsx`.

### Auth email templates live in `supabase/templates/*.html` + `[auth.email.template.*]` in `config.toml` — apply via `pnpm supabase config push`. Studio edits get overwritten. GoTrue uses Go `html/template` (NOT sprig — no `{{ now }}` / pipe filters); parse errors silently fall back to Supabase defaults. Always test with a fresh OTP after deploy.

### `supabase config push` syncs the **entire** `[auth]` block, not just the diff — local dev defaults bake into prod. Never `--yes` until you've eyeballed the interactive diff. CLI shows it exactly once — no undo.

### Migration workflow — (a) never use Supabase MCP `apply_migration` against prod (stamps `version=now()`, blocks next `db push`). Always `migration new` → file → CI `db push`. (b) Types Freshness CI gens from prod, so single-PR with new RPC + new consumer fails CI. Split: PR-A (migration) → release → prod → PR-B (consumer + regen'd types). (c) Data-seed migrations keyed on rows NOT created by an earlier migration (e.g. KWN client/areas exist prod-only + in `seed.sql`, which runs AFTER migrations) must no-op on a fresh `db reset` — sanity check must assert an invariant (rows == entities present), never a hardcoded count, else reset aborts. (d) NEVER reuse a 14-digit migration version prefix already applied to prod — two files sharing a version make `db push` re-run the applied one → `42701` "already exists", aborting the whole batch (EF + Coolify deploy steps silently skip). New migrations use a strictly-greater timestamp; scan the dir for duplicate version prefixes in pre-release review (CI `db push` only catches it at deploy time, on main, after merge). Fix = renumber the *unrecorded* file to a fresh version + `main→develop` back-merge, hand-deleting the stale file (a squash-merged rename does NOT propagate the delete across the phantom-diff). Verify prod migrations via `supabase db query --linked` + RAISE-rollback. See `mcp-apply-migration-version-sync.md` + `ghost-release-pattern.md` + `seed-migration-reset-safety.md`.

### SRF in RLS USING — Postgres rejects set-returning funcs in RLS (`SQLSTATE 0A000`). Use `col IN (SELECT srf())`, NOT `col = ANY(srf())`. Pattern: `contacts_staff_select_via_profiles`.

### plpgsql role gates must be NULL-safe — `current_user_role()` is NULL for a caller with no active `user_roles` row, and `NULL <> 'x'` / `NULL NOT IN (...)` are NULL → falsy in `IF`, silently passing the gate. Gate with `(current_user_role() IN (...)) IS NOT TRUE`. Found empirically in `create_id_booking_with_capacity_check` (20260611031624).

### Capacity-checking RPCs must branch on `collection_area.capacity_pool_id` — pooled areas (VV) keep counters on `collection_date_pool` (the recalc trigger's pooled branch updates ONLY the pool row); checking/locking `collection_date` both fails to enforce and doesn't serialise. Mirror `create_booking_with_capacity_check`'s pooled branch. UI showing per-date counters for pooled areas shows phantom capacity — merge pool counts (see `admin/illegal-dumping/new/page.tsx`).

### RLS coverage lags data plumbing — new FK or relationship to a table with tight RLS needs a matching SELECT policy IN THE SAME MIGRATION. Symptom: data imports fine, admin embeds silently return null. Memory: `rls-coverage-lags-data-plumbing.md`.

### Collection stops (field crew model, 10/06/2026) — a stop = booking × `service.waste_stream` (general/green/ancillary/illegal_dumping); crews collect streams in separate passes. `collection_stop` rows are generated ONLY by the `push-orders-to-optimoroute` EF at T-3 hard close (no INSERT policy). Stop state machine: Pending → terminal, DB-enforced. Booking status derives from stops via `rollup_booking_status_from_stops` (exception wins: NCN > NP > Completed) — never set it directly when stops exist; the reverse trigger `sync_stops_on_booking_status` keeps legacy per-booking closeouts and cancellations consistent. Address/lat/lng/services are denormalised onto the stop so field UIs never join `booking`→`contacts` (PII) and avoid the multi-FK embed gotcha. OptimoRoute sync = 3 cron EFs (push 19:10 UTC / cancel-sweep hourly / pull 4-hourly + admin manual refresh); `OPTIMOROUTE_API_KEY` is an EF secret; pure helpers live in the `_shared/stops.ts` ↔ `src/lib/stops/stops.ts` mirror pair.

### Staged go-live gate (`collection_area.is_active`, WS-A 22/06/2026) — only `is_active = true` areas are bookable, enforced at FOUR layers so no write path bypasses it: client UX (`isAreaBookable`, fail-**OPEN** `!== false` — never hides an area on a transient null), the create-booking EF 403 + `createMudBooking` action + the `create_booking_with_capacity_check` RPC (all fail-**CLOSED** via `isAreaBookableServer` `=== true` / `WHERE id = … AND is_active` + `IF NOT FOUND RAISE`), and the `booking_resident_insert` RLS `WITH CHECK (… AND public.collection_area_is_active(collection_area_id))`. The SECURITY DEFINER helper `collection_area_is_active(uuid)` fails closed (`COALESCE(…, false)`). Pure helpers in the `_shared/area-gate-server.ts` ↔ `src/lib/booking/area-gate-server.ts` mirror pair (+ client `src/lib/booking/area-gate.ts`). **The gate is data-driven, not code-driven** — `is_active` defaults `true`, so holding a council back is an admin **toggle** (Collection Areas tab), never a migration; `createCollectionArea` inherits the `true` default, so create-then-toggle-off when adding an area for a not-yet-live council. Migration `20260622090000`.

### Views default to DEFINER semantics — create WITH (security_invoker = on). A plain `CREATE VIEW` executes as its owner (postgres) and bypasses the caller's RLS; `v_mud_next_expected` leaked cross-tenant booking dates to any caller (incl. anon) until migration `20260702060000` flipped it. Every new view — especially anything feeding council-facing analytics — must be created `WITH (security_invoker = on)`. Companion rule: SECURITY DEFINER helpers and any function the advisor flags `function_search_path_mutable` get `ALTER FUNCTION … SET search_path = public, pg_temp` — pg_temp listed LAST (unlisted, it is implicitly searched FIRST for relations, so a session temp table could shadow `public.user_roles` and subvert the role helpers). Grants: Postgres grants EXECUTE to PUBLIC on function creation, so every public-schema fn is anon-callable via PostgREST `/rpc/` — new staff-only SECURITY DEFINER RPCs must `REVOKE EXECUTE … FROM PUBLIC, anon` in the same migration AND carry the §21 NULL-safe role gate (grants alone don't stop role-less authenticated callers; `retry_notification_log` had neither until `20260702080000`). Do NOT revoke anon from the identity helpers (`current_user_*`, `is_*`, `has_role`, `accessible_client_ids`, `user_sub_client_*`) — RLS policies on the public-SELECT tables reference them and function EXECUTE is permission-checked against the QUERYING role, so revoking anon 42501s the public /book flow; they're inert for anon anyway (auth.uid() NULL). Trigger-only fns need no EXECUTE for any role (checked at CREATE TRIGGER, not fire time). CREATE OR REPLACE resets a fn's `SET search_path` pin — re-declare it in the new definition.

### TZ-correct cancellation cutoff (`src/lib/booking/cancellation-cutoff.ts`, WS-G) — NEVER compute the 3:30pm-AWST-day-prior cutoff with `Date#setHours()` (runtime-TZ-dependent → wrong on the UTC prod container, wrongly blocking valid cancellations + showing the wrong deadline). Use `cancellationCutoff(dateStr)` / `isPastCancellationCutoff(dateStr, now)` — 07:30 UTC via `Date.UTC`, matching the DB trigger `enforce_cancellation_cutoff` exactly. The helper is TZ-independent; the DB trigger is only correct while the Postgres session TimeZone is UTC (Supabase default).

---

## gstack

Per-machine install: `git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && export PATH="$HOME/.bun/bin:$PATH" && bash ~/.claude/skills/gstack/setup`. **Always use `/browse` for web — never `mcp__claude-in-chrome__*`.** Full skill list is in the global `~/.claude/CLAUDE.md`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
