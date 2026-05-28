'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { isAdminHostname, isFieldHostname } from '@/lib/proxy/hostnames'
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
