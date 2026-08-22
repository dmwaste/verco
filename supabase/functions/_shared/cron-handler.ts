// Entry wrapper for cron-invoked Edge Functions (#517 + #518).
//
//   serve(cronHandler('push-orders-to-optimoroute', async (_req) => { ... }))
//
// Composes, outermost first:
//   1. withSentry — exceptions AND 5xx responses are reported (#518; none of
//      the cron EFs were wrapped before, so a caught-and-returned 500 was
//      invisible — the 7-week handle-expired-payments outage, #496).
//   2. Cron auth (#517) — X-Cron-Secret from Vault must match CRON_SECRET, or
//      the bearer must be a proven service-role key. Optional `allowUserRoles`
//      lets a staff JWT through too (manual "Refresh routes" on the admin UI).
//      A rejected request that carries one of OUR routing keys means the
//      secret is misconfigured on one side — reported to Sentry as a warning so
//      it surfaces on the first run, not after weeks of silence.
//
// Deno-only (reads env, talks to Sentry) — deliberately NOT mirrored to src/.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from './database.types.ts'
import { authoriseCronRequest } from './cron-auth.ts'
import { captureWarning, withSentry } from './sentry.ts'

type Handler = (req: Request) => Response | Promise<Response>

function deny(status: number, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function cronHandler(
  name: string,
  handler: Handler,
  opts: { allowUserRoles?: readonly string[] } = {},
): Handler {
  return withSentry(name, async (req) => {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const decision = await authoriseCronRequest(req, {
      cronSecret: Deno.env.get('CRON_SECRET'),
      supabaseUrl,
      serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      anonKey,
    })
    if (decision.ok) return handler(req)

    // Staff JWT path (manual invocation from the admin UI), where allowed.
    if (opts.allowUserRoles && opts.allowUserRoles.length > 0 && supabaseUrl && anonKey) {
      const authHeader = req.headers.get('Authorization') ?? ''
      const userClient = createClient<Database>(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      })
      const {
        data: { user },
      } = await userClient.auth.getUser()
      if (user) {
        const { data: role } = await userClient.rpc('current_user_role')
        if (role && opts.allowUserRoles.includes(role)) return handler(req)
        return deny(403, 'Insufficient permissions.')
      }
    }

    if (decision.looksLikeOurCron) {
      // Our own cron was turned away → CRON_SECRET / Vault secret mismatch.
      console.error(`${name}: cron request rejected (${decision.reason}) — check CRON_SECRET + vault cron_ef_secret`)
      captureWarning(`${name}: cron request rejected — ${decision.reason}`, { reason: decision.reason })
    }
    return deny(401, `Unauthorized (${decision.reason})`)
  })
}
