/**
 * "Which client is the admin user currently viewing?"
 *
 * On `admin.verco.au` the proxy does NOT do hostname→client resolution
 * (admin is contractor-scoped, not client-scoped), so the admin UI needs
 * an explicit "current client" signal. We use a host-only cookie
 * (`CURRENT_ADMIN_CLIENT_COOKIE`) written by the `<ClientSwitcher>`.
 *
 * Resolution order:
 *   1. Switcher cookie (the explicit user choice)
 *   2. x-client-id header from proxy (back-compat for client-subdomain admin
 *      while ADMIN_SUBDOMAIN_ENFORCED=false — old URLs still serve)
 *   3. User's first accessible active client (sane default for first visit)
 *
 * Security: the `client` table is public-SELECT (RLS `USING (is_active = true)`
 * for the unauthenticated /book flow), so a re-query filtered only by
 * `is_active` validates ANY active client id — it does NOT scope to the
 * caller. Both functions therefore filter explicitly to
 * `accessible_client_ids()` (a SECURITY DEFINER helper: contractor users get
 * every client under their contractor, client-tier users get only their own).
 * A tampered cookie / forged x-client-id pointing at a client the user can't
 * access is not in that set, so it falls through to the accessible default
 * (step 3) rather than scoping the admin surface into another tenant.
 */

import { cookies, headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

export const CURRENT_ADMIN_CLIENT_COOKIE = 'verco_admin_client'

export interface CurrentAdminClient {
  id: string
  slug: string
  name: string
  contractorId: string
}

export interface AccessibleAdminClient {
  id: string
  slug: string
  name: string
}

/**
 * The client ids the current user may administer, per `accessible_client_ids()`.
 * Fails closed (empty array) on error or no active role — callers must treat
 * an empty set as "no accessible clients", never as "unfiltered".
 */
async function getAccessibleClientIds(
  supabase: SupabaseClient<Database>,
): Promise<string[]> {
  const { data, error } = await supabase.rpc('accessible_client_ids')
  if (error || !data) return []
  return data
}

export async function getCurrentAdminClient(): Promise<CurrentAdminClient | null> {
  const cookieStore = await cookies()
  const headerStore = await headers()

  const cookieId = cookieStore.get(CURRENT_ADMIN_CLIENT_COOKIE)?.value
  const headerId = headerStore.get('x-client-id')
  const candidateId = cookieId ?? headerId ?? null

  const supabase = await createClient()

  const accessibleIds = await getAccessibleClientIds(supabase)
  if (accessibleIds.length === 0) return null

  // Only accessible clients — the candidate id is honoured only if it is in
  // this set, so a tampered cookie can't scope into another tenant.
  const { data: clients } = await supabase
    .from('client')
    .select('id, slug, name, contractor_id')
    .in('id', accessibleIds)
    .eq('is_active', true)
    .order('name', { ascending: true })

  const list = clients ?? []

  const chosen =
    (candidateId ? list.find((c) => c.id === candidateId) : undefined) ?? list[0]
  if (!chosen) return null

  return {
    id: chosen.id,
    slug: chosen.slug,
    name: chosen.name,
    contractorId: chosen.contractor_id,
  }
}

export async function getAccessibleAdminClients(): Promise<AccessibleAdminClient[]> {
  const supabase = await createClient()

  const accessibleIds = await getAccessibleClientIds(supabase)
  if (accessibleIds.length === 0) return []

  const { data } = await supabase
    .from('client')
    .select('id, slug, name')
    .in('id', accessibleIds)
    .eq('is_active', true)
    .order('name', { ascending: true })

  return data ?? []
}
