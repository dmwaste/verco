import { createClient } from '@/lib/supabase/server'

/**
 * Property ids of the current tenant's MUDs, for scoping queries against the
 * `v_mud_next_expected` view.
 *
 * That view reads from the public-SELECT `eligible_properties` table (RLS
 * `USING(true)`, intentional for the unauthenticated `/book` flow) and exposes
 * no `client_id`, so it returns *every* tenant's Registered MUDs. Admin surfaces
 * must therefore tenant-scope it in app code — pass these ids to
 * `.in('property_id', ids)`. (VER-280: a Kwinana admin was seeing Verge Valet
 * MUDs in the dashboard "MUDs Due Soon" widget.)
 *
 * Returns `[]` when `clientId` is falsy so callers fail closed (show no rows)
 * rather than leaking, mirroring the dashboard's `if (clientId)` scoping guards.
 */
export async function getTenantMudPropertyIds(clientId: string): Promise<string[]> {
  if (!clientId) return []

  const supabase = await createClient()
  const { data } = await supabase
    .from('eligible_properties')
    .select('id, collection_area!inner(client_id)')
    .eq('is_mud', true)
    .eq('collection_area.client_id', clientId)

  return (data ?? []).map((row) => row.id)
}
