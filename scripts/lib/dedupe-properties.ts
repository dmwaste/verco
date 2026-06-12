// scripts/lib/dedupe-properties.ts
import type { EligiblePropertyInsert } from './types'

/**
 * Physical-property dedup for the VV import.
 *
 * The importer's idempotency key is (external_source, external_id) = the
 * Airtable record id, NOT the physical property. The VV Airtable base holds
 * duplicate records for the same house — e.g. "6 Grant Street COTTESLOE…"
 * (correct) and "6 Grant ST PERTH" (mis-coded to the Vincent council code) —
 * which geocode to the same google_place_id. Imported as-is they become two
 * eligible_properties rows, and the public booking lookup reports the address
 * as "not eligible" (it bails when a place_id resolves to >1 row).
 *
 * This guard collapses same-place_id rows to one BEFORE upsert. It only acts on
 * geocoded rows (place_id present) — that's where the observed duplication
 * lives; un-geocoded rows (Main-base / soft-failures) pass through untouched.
 */

/**
 * Derive the geocoded suburb from a Google formatted_address:
 *   "6 Grant St, Cottesloe WA 6011, Australia" → "Cottesloe"
 * Returns null when it can't be determined (caller treats that as "no signal").
 */
export function geocodedSuburb(formattedAddress: string | null): string | null {
  if (!formattedAddress) return null
  const parts = formattedAddress.split(',')
  if (parts.length < 2) return null
  const suburb = parts[1]!.replace(/\s+WA\s+\d+.*$/i, '').trim()
  return suburb || null
}

/** True when the row's raw `address` contains its geocoded suburb. */
export function addressMatchesSuburb(row: EligiblePropertyInsert): boolean {
  const suburb = geocodedSuburb(row.formatted_address)
  if (!suburb) return true // no signal — don't penalise the row
  return row.address.toLowerCase().includes(suburb.toLowerCase())
}

/**
 * Of two rows for the same place_id, prefer the one whose `address` agrees with
 * the geocoded suburb (the mis-sourced "… PERTH" row does not). Ties keep `a`,
 * so the result is deterministic regardless of Airtable fetch order.
 */
export function preferSuburbConsistent(
  a: EligiblePropertyInsert,
  b: EligiblePropertyInsert
): EligiblePropertyInsert {
  const am = addressMatchesSuburb(a)
  const bm = addressMatchesSuburb(b)
  if (am && !bm) return a
  if (bm && !am) return b
  return a
}

export interface DedupeResult {
  /** Rows to upsert: all un-geocoded rows + one winner per place_id. */
  kept: EligiblePropertyInsert[]
  /** Skipped — place_id already exists in Verco for this client. */
  droppedExisting: EligiblePropertyInsert[]
  /** Skipped — duplicate place_id within this run; the suburb-consistent row won. */
  droppedInBatch: EligiblePropertyInsert[]
}

/**
 * Collapse rows so each google_place_id maps to a single property.
 *
 * @param rows              candidate inserts for one base (already geocoded)
 * @param existingPlaceIds  place_ids already present in Verco for this client;
 *                          this set is MUTATED with each kept place_id so a
 *                          later base in the same run sees them (cross-base dedup)
 */
export function dedupeByPlaceId(
  rows: EligiblePropertyInsert[],
  existingPlaceIds: Set<string>
): DedupeResult {
  const chosen = new Map<string, EligiblePropertyInsert>()
  const passthrough: EligiblePropertyInsert[] = []
  const droppedExisting: EligiblePropertyInsert[] = []
  const droppedInBatch: EligiblePropertyInsert[] = []

  for (const row of rows) {
    const pid = row.google_place_id
    if (!pid) {
      passthrough.push(row) // un-geocoded — cannot dedup by place_id
      continue
    }
    if (existingPlaceIds.has(pid)) {
      droppedExisting.push(row)
      continue
    }
    const prev = chosen.get(pid)
    if (!prev) {
      chosen.set(pid, row)
      continue
    }
    const winner = preferSuburbConsistent(prev, row)
    droppedInBatch.push(winner === prev ? row : prev)
    chosen.set(pid, winner)
  }

  // Record the survivors so subsequent bases in the same run dedup against them.
  for (const pid of chosen.keys()) existingPlaceIds.add(pid)

  return {
    kept: [...passthrough, ...chosen.values()],
    droppedExisting,
    droppedInBatch,
  }
}
