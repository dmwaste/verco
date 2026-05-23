import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Maps Airtable Council_Code (e.g. "FRE-S") to Verco collection_area.id.
 *
 * Vincent is collapsed: both legacy Airtable codes "VIN-B" and "VIN-G"
 * map to the single Verco area "VIN".
 */
export type AreaMap = Map<string, string>

const VINCENT_COLLAPSE: Record<string, string> = {
  'VIN-B': 'VIN',
  'VIN-G': 'VIN',
}

export async function loadAreaMap(verco: SupabaseClient): Promise<AreaMap> {
  const { data: client, error: clientErr } = await verco
    .from('client')
    .select('id')
    .eq('slug', 'vergevalet')
    .single()
  if (clientErr || !client) {
    throw new Error(`Could not find client with slug 'vergevalet'. Run the migration first. ${clientErr?.message ?? ''}`)
  }

  const { data: areas, error: areasErr } = await verco
    .from('collection_area')
    .select('id, code')
    .eq('client_id', client.id)
  if (areasErr) throw new Error(`Could not load collection_areas: ${areasErr.message}`)
  if (!areas || areas.length === 0) {
    throw new Error("vergevalet client has zero collection_areas. Run the migration first.")
  }

  const map: AreaMap = new Map()
  for (const a of areas) map.set(a.code, a.id)

  if (map.size !== 11) {
    throw new Error(`Expected 11 collection_areas for vergevalet, found ${map.size}. Codes: ${[...map.keys()].join(', ')}`)
  }
  return map
}

/**
 * Load collection areas for any client by slug. No hardcoded count check.
 * Use this for non-VV clients (e.g. KWN).
 */
export async function loadAreaMapForClient(verco: SupabaseClient, clientSlug: string): Promise<AreaMap> {
  const { data: client, error: clientErr } = await verco
    .from('client')
    .select('id')
    .eq('slug', clientSlug)
    .single()
  if (clientErr || !client) {
    throw new Error(`Could not find client with slug '${clientSlug}'. ${clientErr?.message ?? ''}`)
  }

  const { data: areas, error: areasErr } = await verco
    .from('collection_area')
    .select('id, code')
    .eq('client_id', client.id)
  if (areasErr) throw new Error(`Could not load collection_areas for '${clientSlug}': ${areasErr.message}`)
  if (!areas || areas.length === 0) {
    throw new Error(`Client '${clientSlug}' has zero collection_areas.`)
  }

  const map: AreaMap = new Map()
  for (const a of areas) map.set(a.code, a.id)
  return map
}

/**
 * Resolve a Council_Code from Airtable to a Verco area UUID.
 * Returns null if the code has no Verco mapping (caller treats as hard error).
 */
export function resolveAreaId(airtableCode: string, map: AreaMap): string | null {
  const collapsed = VINCENT_COLLAPSE[airtableCode] ?? airtableCode
  return map.get(collapsed) ?? null
}
