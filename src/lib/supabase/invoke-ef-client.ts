import { createClient } from '@/lib/supabase/client'
import type { Result } from '@/lib/result'

type BrowserClient = ReturnType<typeof createClient>

/**
 * Client-side Edge Function invoker. Gets the user session token and POSTs to
 * the named function. Returns Result<T> — callers handle error display.
 *
 * Pass `fallbackToAnon: true` ONLY for EFs that genuinely accept the anon key
 * — i.e. presence-only auth that never calls `auth.getUser()` (e.g.
 * google-places-proxy on the public /book flow). Do NOT use it for EFs that
 * validate the caller's role: those reject the anon key with a 401, so the
 * fallback can only ever turn a clear "no session" into a confusing server
 * error. Such EFs (geocode-properties, create-user, …) need a real user JWT.
 *
 * Per CLAUDE.md §11: use direct fetch, not supabase.functions.invoke().
 */
export async function invokeEfWithUserToken<T = unknown>(
  supabase: BrowserClient,
  name: string,
  payload: unknown,
  { fallbackToAnon = false }: { fallbackToAnon?: boolean } = {}
): Promise<Result<T>> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl) return { ok: false, error: 'NEXT_PUBLIC_SUPABASE_URL not set' }

  const { data: { session }, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) return { ok: false, error: `Session error: ${sessionError.message}` }

  const token =
    session?.access_token ??
    (fallbackToAnon ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY : undefined)

  if (!token) return { ok: false, error: 'No active session. Please sign in and try again.' }

  const res = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)')
    return { ok: false, error: body }
  }

  if (res.status === 204) return { ok: true, data: undefined as T }
  try {
    return { ok: true, data: (await res.json()) as T }
  } catch {
    return { ok: false, error: 'EF returned non-JSON response' }
  }
}
