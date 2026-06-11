import type { Database } from '@/lib/supabase/types'

/** Shape selected by the landing page's client query. */
export type PickerClient = Pick<
  Database['public']['Tables']['client']['Row'],
  | 'slug'
  | 'name'
  | 'custom_domain'
  | 'service_name'
  | 'primary_colour'
  | 'accent_colour'
  | 'logo_light_url'
>

export type PickerState =
  | { kind: 'cards'; clients: PickerClient[] }
  | { kind: 'none-live' }
  | { kind: 'unavailable' }

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
