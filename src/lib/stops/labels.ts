import type { WasteStream } from './stops'

/**
 * Human-readable label per waste stream. Used on field stop cards, the stop
 * closeout surface, and named in resident-facing NCN/NP notifications
 * ("This notice applies to the Green collection").
 */
export const STREAM_LABEL: Record<WasteStream, string> = {
  general: 'General',
  green: 'Green',
  ancillary: 'Ancillary',
  illegal_dumping: 'Illegal Dumping',
}

/**
 * Google Maps deep link for a stop. Prefers exact coordinates (denormalised
 * onto collection_stop at push time); falls back to the address string.
 */
export function getStopMapsUrl(
  latitude: number | null,
  longitude: number | null,
  address: string | null,
): string | null {
  if (latitude && longitude) return `https://maps.google.com/?q=${latitude},${longitude}`
  if (address) return `https://maps.google.com/?q=${encodeURIComponent(address)}`
  return null
}
