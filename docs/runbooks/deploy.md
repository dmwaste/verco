# Deploy runbook — Verco

How we get code onto Coolify/BinaryLane, and how to get it back off when something breaks.

## Architecture

- **Next.js app** — Docker image built by GitHub Actions, pushed to GHCR, pulled by Coolify on webhook trigger.
- **Edge Functions** — deployed directly by GitHub Actions to Supabase (`supabase functions deploy --no-verify-jwt`). Not part of the Docker image.
- **Database** — Supabase-hosted Postgres. Migrations are applied automatically by GitHub Actions (`supabase db push --linked`). Requires the `SUPABASE_DB_PASSWORD` GitHub secret.

```
push to main
      │
      ▼
  ci (reused from ci.yml — build + test + typecheck + types-check + template-sync + e2e)
      │
      ├──► docker            → ghcr.io/dmwaste/verco:<sha>  +  :latest
      │
      └──► migrations        → supabase db push --linked --include-all
                  │
                  ▼
              edge-functions  → supabase functions deploy <each> --no-verify-jwt
                                then assert verify_jwt=false via management API (VER-156 guard)
      │
      ▼
  coolify                    → POST webhook → poll /api/health until SHA matches
```

`migrations` runs before `edge-functions` so an EF that depends on a new column/table/policy doesn't crash on its first invocation. If `migrations` fails, neither EFs nor the new Coolify image ship.

## Normal deploy

1. Open a PR against `main`. CI runs.
2. On merge, `deploy.yml` triggers automatically.
3. Watch the Actions tab. Expected timing: CI ~4 min, docker ~3 min, edge-functions ~4 min, coolify ~1-3 min.
4. Green = live. `curl -s https://<prod-host>/api/health | jq` to confirm SHA.

Manual trigger (redeploy without a new commit): Actions → Deploy → Run workflow.

## Secrets map — where each value lives

| Secret | Lives in | Used by |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | GitHub Actions secret | Docker build-arg (baked into client bundle) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | GitHub Actions secret | Docker build-arg (baked into client bundle) |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | GitHub Actions secrets | Docker build-args — DSN baked into the client bundle; org/project/token used only for source-map upload at build |
| `SUPABASE_ACCESS_TOKEN` | GitHub Actions secret | `supabase functions deploy` + VER-156 guard API call |
| `COOLIFY_WEBHOOK_URL` | GitHub Actions secret | `coolify` job |
| `COOLIFY_API_TOKEN` | GitHub Actions secret | `coolify` job (bearer auth on webhook) |
| `PROD_HEALTH_URL` | GitHub Actions secret | `coolify` job post-deploy verification |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase secrets set` (EF scope only) | Edge Functions. **Never** in Next.js image or Coolify env. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `supabase secrets set` | `create-checkout`, `stripe-webhook` EFs |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` | `supabase secrets set` | `send-notification` EF |
| `GOOGLE_PLACES_API_KEY` | `supabase secrets set` | `google-places-proxy` EF |
| `CRON_SECRET` | `supabase secrets set` **and** Supabase Vault as `cron_ef_secret` (same value, never in git) | Every cron-invoked EF (`_shared/cron-handler.ts`, #517). pg_cron reads the Vault copy at run time and sends it as `X-Cron-Secret`; the EF compares it to its env copy. Rotate both together or every cron 401s — a mismatch raises a Sentry warning on the first run. |
| `SENTRY_DSN` | `supabase secrets set` | All EFs (`withSentry`) — inert when unset |

Coolify runtime env is intentionally thin: `NODE_ENV=production`, `PORT=3000`, `HOSTNAME=0.0.0.0`, plus `ADMIN_SUBDOMAIN_ENFORCED=true` (server-runtime flag that 308s `{tenant}/admin/*` and `/field/*` to `admin.verco.au` / `field.verco.au`). Nothing else — `NEXT_PUBLIC_*` values are build-time only and a runtime edit is a no-op.

## Rollback — Next.js (fast path)

Every successful deploy tags two images: `:${sha}` and `:latest`. The SHA tag is the authoritative rollback target.

1. Identify the last known-good commit SHA (GitHub Actions history, or `git log`).
2. Coolify UI → Application → General → Image: change from `ghcr.io/dmwaste/verco:latest` to `ghcr.io/dmwaste/verco:<known-good-sha>`.
3. Click Redeploy.
4. `curl -s $PROD_HEALTH_URL | jq` → confirm `.sha` matches the rollback SHA.
5. After root-causing the bad deploy, roll forward by reverting the offending commit on `main` and letting the normal deploy flow ship it. Reset Coolify back to `:latest` so future deploys land automatically.

## Rollback — Edge Functions (slower path)

Supabase EFs aren't versioned in the platform. To roll an EF back:

```bash
git checkout <known-good-sha> -- supabase/functions/<function-name>
pnpm supabase functions deploy <function-name> \
  --project-ref tfddjmplcizfirxqhotv \
  --no-verify-jwt
git checkout HEAD -- supabase/functions/<function-name>   # restore working tree
```

Then verify in the Supabase dashboard (Edge Functions → `<function-name>` → JWT verification must show "Disabled"). If not, redeploy with `--no-verify-jwt` explicitly — the next CI run will fail the VER-156 guard otherwise.

## Manual EF redeploy (outside the pipeline)

Avoid when possible — the CI pipeline is the contract. When required (incident response, urgent fix):

```bash
pnpm supabase functions deploy <name> \
  --project-ref tfddjmplcizfirxqhotv \
  --no-verify-jwt
```

**Always pass `--no-verify-jwt`.** Missing it caused the 8-day `send-notification` outage (VER-156). The CI guard will fail the next deploy if you forget, but residents feel it in the meantime.

## Healthcheck contract

`GET /api/health` — no auth, no tenant context, bypasses `src/proxy.ts`.

- `200 { status: "ok", sha, time }` — app is serving and DB ping succeeded
- `503 { status: "degraded", sha, time, error }` — app is serving but DB is unreachable

Used by: Docker HEALTHCHECK (internal 127.0.0.1), deploy.yml post-deploy poll, Coolify healthcheck config, external uptime monitors.

## Known failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `docker` job fails at `grep SUPABASE_SERVICE_ROLE_KEY` | Someone imported the service role key into `src/` | Move the code to an Edge Function. CLAUDE.md §16 red line #3. |
| VER-156 guard step fails | An EF was deployed outside CI without `--no-verify-jwt` | Redeploy that EF with the flag, or let the next normal deploy fix it. |
| Coolify poll times out with `status: "degraded"` | App running but Supabase unreachable from BinaryLane | Check Supabase status, check Coolify network config, check anon key hasn't been rotated without updating GHA secret. |
| Coolify poll times out with `sha` mismatch | Coolify didn't pick up the new image | Check Coolify UI → Deployments log. Re-trigger webhook. Verify GHCR image exists at the expected tag. |
| `sharp` runtime error in container | Alpine musl binary missing | Fallback: switch Dockerfile `runner` base to `node:20-slim` (Debian). Image grows ~80 MB. |
