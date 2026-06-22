/**
 * Waste-stream reporting helpers (WS-D / VER-272).
 *
 * Each `booking_item` books a quantity (`no_services`) of a service, and each
 * service carries a `waste_stream` (`general` | `green` | `ancillary` |
 * `illegal_dumping`). These helpers turn (stream, quantity) pairs into per-stream
 * collection totals for the admin Reports page — **weighted by `no_services`**,
 * matching how the rest of the app counts collections (address-form allocation
 * usage, the admin dashboard, the pricing engine). Counting rows instead would
 * undercount every multi-unit booking. `general` + `green` are the Verge Valet
 * streams (both in the `bulk` capacity bucket); `ancillary` is Kwinana;
 * `illegal_dumping` is the ID intake path.
 */

export const WASTE_STREAM_LABELS: Record<string, string> = {
  general: 'General waste',
  green: 'Green waste',
  ancillary: 'Ancillary',
  illegal_dumping: 'Illegal dumping',
}

export const WASTE_STREAM_ORDER = [
  'general',
  'green',
  'ancillary',
  'illegal_dumping',
] as const

/** Sum collection units (no_services) per waste stream, ignoring null streams. */
export function countByWasteStream(
  items: Array<{ stream: string | null | undefined; quantity: number }>
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const { stream, quantity } of items) {
    if (!stream) continue
    counts[stream] = (counts[stream] ?? 0) + quantity
  }
  return counts
}
