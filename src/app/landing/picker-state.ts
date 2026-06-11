import type { Database } from '@/lib/supabase/types'

/** Columns selected by the landing page's client query. */
type PickerClientColumns = Pick<
  Database['public']['Tables']['client']['Row'],
  | 'id'
  | 'slug'
  | 'name'
  | 'custom_domain'
  | 'service_name'
  | 'primary_colour'
  | 'accent_colour'
  | 'logo_light_url'
>

/**
 * A client card. `subClients` carries the active member-council names for a
 * multi-LGA client (e.g. Verge Valet → Fremantle, Vincent, …); single-LGA
 * clients get an empty list and render no recognition line.
 */
export type PickerClient = PickerClientColumns & { subClients: string[] }

export type PickerState =
  | { kind: 'cards'; clients: PickerClient[] }
  | { kind: 'none-live' }
  | { kind: 'unavailable' }

type SubClientRow = { client_id: string; name: string }

/**
 * Attaches each client's active member-council names, preserving client
 * order. Sub-clients are a recognition aid only — a failed/empty sub-client
 * fetch degrades to empty lists (no card loses its Book action), so this
 * never feeds the unavailable state; only the client query does.
 */
export function attachSubClients(
  clients: PickerClientColumns[],
  subClients: SubClientRow[] | null
): PickerClient[] {
  const byClient = new Map<string, string[]>()
  for (const sc of subClients ?? []) {
    const list = byClient.get(sc.client_id) ?? []
    list.push(sc.name)
    byClient.set(sc.client_id, list)
  }
  return clients.map((c) => ({ ...c, subClients: byClient.get(c.id) ?? [] }))
}

/**
 * Derives the council-picker render state. A query ERROR and a genuinely
 * empty tenant list are different stories for the visitor: an outage says
 * "try again shortly", an empty platform says "no councils live yet".
 * Conflating them (the old behaviour) showed "no councils configured"
 * during Supabase outages.
 */
export function pickerState(
  rows: PickerClient[] | null,
  error: { message: string } | null
): PickerState {
  if (error || rows === null) return { kind: 'unavailable' }
  if (rows.length === 0) return { kind: 'none-live' }
  return { kind: 'cards', clients: rows }
}
