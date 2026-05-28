'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { CURRENT_ADMIN_CLIENT_COOKIE } from './current-client'
import type { Result } from '@/lib/result'

/**
 * Persists the admin user's "current client" selection. The cookie is
 * host-only (no Domain attribute) so the choice only applies on the host
 * that wrote it — admin.verco.au sessions don't leak their selection into
 * client-subdomain sessions or vice versa.
 *
 * Validates the user has access to the chosen client BEFORE writing the
 * cookie; a tampered request that POSTs an arbitrary UUID gets a clean
 * `client not accessible` response, not a silent successful write.
 */
export async function setCurrentAdminClient(
  clientId: string
): Promise<Result<{ id: string }>> {
  if (!clientId || typeof clientId !== 'string') {
    return { ok: false, error: 'Client id is required.' }
  }

  const supabase = await createClient()
  const { data: client } = await supabase
    .from('client')
    .select('id')
    .eq('id', clientId)
    .eq('is_active', true)
    .maybeSingle()

  if (!client) {
    return { ok: false, error: 'Client not accessible.' }
  }

  const cookieStore = await cookies()
  cookieStore.set(CURRENT_ADMIN_CLIENT_COOKIE, clientId, {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  })

  // Refresh every admin page so the new client context flows through layout +
  // page-level server reads.
  revalidatePath('/admin', 'layout')

  return { ok: true, data: { id: client.id } }
}
