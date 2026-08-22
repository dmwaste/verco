/**
 * Auth gate for cron-invoked Edge Functions (#517).
 *
 * Every EF deploys with `--no-verify-jwt`, and the cron EFs did nothing further
 * — anyone with the URL could trigger an early OptimoRoute push, a forced
 * transition-scheduled, a DM-Ops sync, or burn SMS quota via reminders. The
 * pg_cron jobs can't send the service-role key (no GUC / secret access from
 * SQL — memory `cron-pg-net-gucs-and-silent-rls`), so they send the PUBLIC anon
 * or publishable key as a routing bearer. That key proves nothing.
 *
 * Gate: a shared secret in the `X-Cron-Secret` header. pg_cron reads it at run
 * time from Supabase Vault (`vault.decrypted_secrets` name `cron_ef_secret`,
 * migration 20260822090000) and the EF compares it to its `CRON_SECRET` env
 * secret — the same value, set once in each place, never in git. A genuine
 * service-role bearer is also accepted so CLI / manual invocations keep working.
 *
 * Fail-closed. If the EF secret is unset or the header is missing, the request
 * is rejected — and, because that is exactly the silent-cron-death class
 * (#518), a rejection that carries one of our own routing keys is reported to
 * Sentry so a misconfigured secret surfaces within one run.
 *
 * Pure decision mirrored to `src/lib/auth/cron-request.ts` for Vitest.
 */
import { classifyServiceRoleBearer, isServiceRoleBearer } from './service-role-auth'

export type CronAuthDecision =
  | { ok: true; via: 'cron-secret' | 'service-role' }
  | { ok: false; reason: 'no-secret-configured' | 'bad-secret' | 'not-service-role'; looksLikeOurCron: boolean }

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Pure decision. `bearerClass` is the result of classifyServiceRoleBearer for
 * the Authorization bearer (network probe happens in the async wrapper).
 */
export function decideCronAuth(args: {
  headerSecret: string | null
  envSecret: string | undefined
  bearer: string
  bearerIsServiceRole: boolean
  anonKey: string | undefined
}): CronAuthDecision {
  const { headerSecret, envSecret, bearer, bearerIsServiceRole, anonKey } = args
  if (bearerIsServiceRole) return { ok: true, via: 'service-role' }
  // "Looks like our cron" = carries the routing bearer pg_cron sends (anon JWT
  // or a publishable key). Used only to decide whether to alert on rejection.
  const looksLikeOurCron =
    bearer.length > 0 && ((anonKey !== undefined && bearer === anonKey) || bearer.startsWith('sb_publishable_'))
  if (!envSecret) return { ok: false, reason: 'no-secret-configured', looksLikeOurCron }
  if (headerSecret && safeEqual(headerSecret, envSecret)) return { ok: true, via: 'cron-secret' }
  if (headerSecret === null || headerSecret === '') {
    return { ok: false, reason: 'not-service-role', looksLikeOurCron }
  }
  return { ok: false, reason: 'bad-secret', looksLikeOurCron }
}

/** Async wrapper for EFs: reads env + headers, probes a claimed service-role bearer. */
export async function authoriseCronRequest(
  req: Request,
  env: { cronSecret: string | undefined; supabaseUrl: string | undefined; serviceRoleKey: string | undefined; anonKey: string | undefined },
): Promise<CronAuthDecision> {
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const cls = classifyServiceRoleBearer(bearer, env.serviceRoleKey)
  const bearerIsServiceRole =
    cls === 'match' ||
    (cls === 'claims' && (await isServiceRoleBearer(bearer, { supabaseUrl: env.supabaseUrl, serviceRoleKey: env.serviceRoleKey })))
  return decideCronAuth({
    headerSecret: req.headers.get('x-cron-secret'),
    envSecret: env.cronSecret,
    bearer,
    bearerIsServiceRole,
    anonKey: env.anonKey,
  })
}
