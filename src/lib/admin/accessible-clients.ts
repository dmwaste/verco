import { createClient } from '@/lib/supabase/client'

type BrowserClient = ReturnType<typeof createClient>

export interface ClientOption {
  id: string
  name: string
}

type FetchAccessibleIds = () => Promise<string[] | null>
type FetchClientsByIds = (ids: string[]) => Promise<ClientOption[]>

/**
 * Core logic, dependency-injected for tests (pattern: resolveOnBehalfClient).
 * No accessible ids → no client query at all: the `client` table is
 * public-SELECT (CLAUDE.md §21), so an unnarrowed read returns every tenant
 * on the platform.
 */
export async function resolveAccessibleClientOptions(
  fetchAccessibleIds: FetchAccessibleIds,
  fetchClientsByIds: FetchClientsByIds
): Promise<ClientOption[]> {
  const ids = await fetchAccessibleIds()
  if (!ids || ids.length === 0) return []
  return fetchClientsByIds(ids)
}

/**
 * Active clients the caller may act on, for admin pickers (#456). Always
 * narrow through accessible_client_ids() — never offer a client-tier user
 * another council as a selectable option.
 */
export async function fetchAccessibleClientOptions(
  supabase: BrowserClient
): Promise<ClientOption[]> {
  return resolveAccessibleClientOptions(
    async () => (await supabase.rpc('accessible_client_ids')).data,
    async (ids) => {
      const { data } = await supabase
        .from('client')
        .select('id, name')
        .in('id', ids)
        .eq('is_active', true)
        .order('name')
      return data ?? []
    }
  )
}
