/**
 * Service-role bearer recognition for dual-auth Edge Functions (#480).
 *
 * The old gate was an exact string compare against the env-injected service key.
 * That exact-string match breaks the moment the project has more than one
 * valid secret in play — the legacy service JWT and a new-format
 * `sb_secret_…` key are BOTH accepted by the Supabase gateway, but only one of
 * them is injected into the EF env, so a CLI/cron caller holding the other
 * gets a 401 (29/07: geocoding the #460 MUD import; same class as the
 * OptimoRoute pull-cron 401s).
 *
 * Two layers, mirrored to `src/lib/auth/service-role-bearer.ts` for Vitest:
 *
 *   classifyServiceRoleBearer — pure. Exact match → 'match' (no network).
 *     A bearer that merely CLAIMS service role (JWT with role=service_role, or
 *     an sb_secret_ key) → 'claims'. Anything else → 'no'.
 *
 *   isServiceRoleBearer — for 'claims', proves the key is genuinely valid by
 *     asking the gateway itself (GET /rest/v1/ with the bearer as apikey:
 *     PostgREST answers 200 for a valid key, 401 otherwise). We never accept
 *     a claimed role on the caller's say-so — the signature check is
 *     delegated to the only party holding the JWT secret.
 *
 * Never exact-match against an empty env key: `'' === ''` would authenticate
 * `Authorization: Bearer ` as service role.
 */

export type BearerClass = 'match' | 'claims' | 'no'

function jwtRole(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payloadB64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4))
    const payload = JSON.parse(json) as { role?: unknown }
    return typeof payload.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}

/** Constant-time string equality (both sides already non-empty). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function classifyServiceRoleBearer(
  bearer: string,
  envServiceRoleKey: string | undefined,
): BearerClass {
  if (!bearer) return 'no'
  if (envServiceRoleKey && safeEqual(bearer, envServiceRoleKey)) return 'match'
  if (bearer.startsWith('sb_secret_')) return 'claims'
  if (jwtRole(bearer) === 'service_role') return 'claims'
  return 'no'
}

/**
 * True iff `bearer` is a valid service-role secret for this project.
 * `supabaseUrl` / `envServiceRoleKey` are injected so the Deno and Node
 * copies stay identical (no `Deno.env` in the mirror).
 */
export async function isServiceRoleBearer(
  bearer: string,
  env: { supabaseUrl: string | undefined; serviceRoleKey: string | undefined },
): Promise<boolean> {
  const cls = classifyServiceRoleBearer(bearer, env.serviceRoleKey)
  if (cls === 'match') return true
  if (cls === 'no' || !env.supabaseUrl) return false
  try {
    const res = await fetch(`${env.supabaseUrl}/rest/v1/`, {
      method: 'GET',
      headers: { apikey: bearer, Authorization: `Bearer ${bearer}` },
    })
    return res.ok
  } catch {
    return false
  }
}
