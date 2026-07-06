# Verco v2

White-labelled, multi-tenant SaaS platform for managing residential bulk verge collection bookings on behalf of WA local governments.

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 (strict mode) |
| Styling | Tailwind CSS 4 |
| UI | shadcn/ui (Radix primitives) |
| Forms | react-hook-form + zod |
| Server state | TanStack Query v5 |
| Backend | Supabase (AU, ap-southeast-2) |
| Auth | Supabase Auth (email OTP) |
| Payments | Stripe |
| Package manager | pnpm |
| Testing | Vitest + Testing Library + Playwright |
| Maps | Leaflet + OpenStreetMap |
| Hosting | Coolify on BinaryLane |

## Local Development

```bash
git clone <repo-url> && cd verco
pnpm install
```

Copy `.env.local.example` to `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
```

Start the dev server:

```bash
pnpm dev
```

### Secret scanning

Secrets are caught in two places:

- **Locally** — a `pre-commit` hook (wired automatically by `pnpm install` via `core.hooksPath`, no per-clone step) runs [gitleaks](https://github.com/gitleaks/gitleaks) over your staged changes. Install the CLI once so the gate activates:
  ```bash
  brew install gitleaks
  ```
  Without it installed the hook skips (printing a hint), and `git commit --no-verify` bypasses it — CI is the non-bypassable backstop either way.
- **In CI** — the `gitleaks` workflow re-scans full history on every push/PR, and the `semgrep` workflow runs SAST (static analysis). Allowlists for public-by-design values (Supabase anon keys, Airtable base IDs) live in [`.gitleaks.toml`](.gitleaks.toml).

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start Next.js dev server |
| `pnpm build` | Production build |
| `pnpm test` | Run Vitest unit tests |
| `pnpm test:e2e` | Run Playwright E2E tests |
| `pnpm test:coverage` | Coverage report |
| `pnpm typecheck` | TypeScript type check |
| `pnpm lint` | ESLint |

## Documentation

- [Product Requirements (PRD)](docs/VERCO_V2_PRD.md)
- [Technical Specification](docs/VERCO_V2_TECH_SPEC.md)
- [Admin Design System](docs/admin-design-system.md) — tokens, shared components, status pills (read before touching an admin page)
