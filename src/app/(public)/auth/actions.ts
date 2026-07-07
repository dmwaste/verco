'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isAdminHostname, isFieldHostname } from '@/lib/proxy/hostnames'
import { signOutRedirectPath } from '@/lib/auth/sign-out'
import type { Result } from '@/lib/result'

export async function sendOtp(email: string): Promise<Result<void>> {
  if (!email || typeof email !== 'string') {
    return { ok: false, error: 'Email is required.' }
  }

  const headerStore = await headers()
  const clientId = headerStore.get('x-client-id')
  const host = headerStore.get('host') ?? ''

  // Admin / field hosts have no tenant context — that's expected. For
  // client subdomains we still require x-client-id so the user-metadata
  // `client_id` stamp (used to bind residents/strata to their origin
  // tenant) can be recorded.
  const isContractorHost = isAdminHostname(host) || isFieldHostname(host)

  if (!clientId && !isContractorHost) {
    return { ok: false, error: 'Unable to resolve tenant.' }
  }

  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      data: clientId ? { client_id: clientId } : undefined,
    },
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  return { ok: true, data: undefined }
}

/**
 * Ends the current session. `scope: 'local'` revokes only THIS device's refresh
 * token. Field crews share one login across a crew device + personal phones, so
 * a global sign-out (revoke-everywhere) bumped the whole crew when any one
 * person logged out. Local scope keeps the other devices signed in.
 *
 * Must run as a server action (not a server component): `server.ts` swallows
 * cookie writes in a server-component context, so the cookie clearing only
 * persists from here.
 *
 * Destination comes from a hidden form field and is mapped to one of two
 * hardcoded internal paths — never used as a URL — so a tampered value can
 * only ever resolve to `/auth` (the default). No open-redirect surface.
 *   staff/field surfaces → 'login' → /auth   |   resident → 'home' → /
 */
export async function signOutAction(formData: FormData): Promise<void> {
  const target = signOutRedirectPath(formData.get('destination'))
  const supabase = await createClient()
  await supabase.auth.signOut({ scope: 'local' })
  redirect(target)
}
