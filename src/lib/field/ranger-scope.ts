import type { createClient } from '@/lib/supabase/server'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export interface RangerScope {
  clientId: string
  subClientId: string | null
  /** Active collection-area ids the ranger may see (sub-client narrowed). */
  areaIds: string[]
  /** Codes for the same scoped areas, ordered — drives the header pill. */
  areaCodes: string[]
  clientName: string
  placeOutHoursBefore: number
}

/**
 * Tenant scope for ranger surfaces. Rangers sign in on field.verco.au where
 * the proxy never sets x-client-id, and the tables they search
 * (eligible_properties, collection_area, collection_date) are public-SELECT
 * — RLS does NOT tenant-scope them (CLAUDE.md §21). Every ranger query MUST
 * app-filter through this scope's areaIds or clientId — including the field
 * layout's header pill, which reads areaCodes (a raw collection_area query
 * would leak every client's codes, e.g. KWN-* to a Verge Valet ranger).
 *
 * Source of truth is the ranger's own user_roles row (RLS: user_id =
 * auth.uid()), narrowed to a sub-client when user_roles.sub_client_id is set
 * (VER-216 — e.g. a City of Cockburn ranger under Verge Valet).
 */
export async function getRangerScope(
  supabase: SupabaseServerClient,
): Promise<RangerScope | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  // Mirror current_user_role()'s semantics: an inactive or non-ranger row
  // must never mint a scope, even though every current caller also gates on
  // the role RPC — this helper must fail closed on its own.
  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('client_id, sub_client_id')
    .eq('user_id', user.id)
    .eq('role', 'ranger')
    .eq('is_active', true)
    .maybeSingle()
  if (!roleRow?.client_id) return null

  let areaQuery = supabase
    .from('collection_area')
    .select('id, code')
    .eq('client_id', roleRow.client_id)
    .eq('is_active', true)
    .order('code')
  if (roleRow.sub_client_id) {
    areaQuery = areaQuery.eq('sub_client_id', roleRow.sub_client_id)
  }
  const { data: areas, error: areasError } = await areaQuery

  const { data: client, error: clientError } = await supabase
    .from('client')
    .select('name, place_out_hours_before')
    .eq('id', roleRow.client_id)
    .single()

  // Fail CLOSED on query errors: a transient failure must surface as
  // "no scope" (callers redirect), never as areaIds: [] ("no areas
  // assigned") or placeOutHoursBefore: 0 (skews the place-out verdict).
  if (areasError || clientError || !client) return null

  return {
    clientId: roleRow.client_id,
    subClientId: roleRow.sub_client_id,
    areaIds: (areas ?? []).map((a) => a.id),
    areaCodes: (areas ?? []).map((a) => a.code),
    clientName: client.name,
    placeOutHoursBefore: client.place_out_hours_before,
  }
}
