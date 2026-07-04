import { format } from 'date-fns'
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

/**
 * Split a denormalised stop address into a prominent street line + a smaller
 * suburb line. Commas beyond the first stay with the suburb; a comma-less
 * address is treated as all-street.
 */
export function splitAddress(address: string | null): { street: string; suburb: string } {
  const full = address ?? ''
  const parts = full.split(',')
  return {
    street: parts[0]?.trim() ?? full,
    suburb: parts.slice(1).join(',').trim() || '',
  }
}

/**
 * 'HH:MM:SS' (Postgres `time`) → 'h:mma' for run-sheet headers. Time-of-day
 * only, so it's timezone-agnostic (no date component crosses a TZ boundary).
 */
export function formatTime(time: string | null): string | null {
  const match = time?.match(/^(\d{2}):(\d{2})/)
  if (!match) return null
  const d = new Date()
  d.setHours(Number(match[1]), Number(match[2]), 0, 0)
  return format(d, 'h:mmaaa')
}
