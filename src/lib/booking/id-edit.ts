import { z } from 'zod'
import { idIntakeSchema } from './id-intake'

// Illegal Dumping edit helpers — shared by the admin booking-detail edit UI
// and the updateIdDetails server action so the two layers apply ONE
// definition of "changed", "preserved", and "valid".
// Design: docs/superpowers/specs/2026-08-28-id-booking-edit-design.md

/**
 * Edit-payload schema, derived from the intake schema — never a re-typed
 * parallel copy. Differences from intake are deliberate:
 *
 * - The pin pair is NULLABLE with a both-null-or-both-set refine: booking
 *   lat/lng are nullable columns and pinless ID bookings must stay editable
 *   (a bare `.pick()` would fail zod on every pinless save).
 * - `geo_address` tightens to trim().min(1) — the intake schema permits the
 *   empty string for the field/GPS flow, but an edit must never blank the
 *   crew-facing label.
 * - `waste_types` drops the enum-only constraint in favour of a caller-built
 *   allowlist (see buildWasteTypeAllowlist): stored legacy/renamed tags stay
 *   saveable if untouched (memory service-name-rename-gotcha), while NEW
 *   tags must come from ID_WASTE_TYPES.
 */
const idEditBaseSchema = idIntakeSchema
  .pick({ volume: true, photo_urls: true })
  .extend({
    geo_address: z.string().trim().min(1, 'Address is required').max(500),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    waste_types: z.array(z.string().min(1).max(100)).min(1, 'Select at least one waste type').max(20),
    // Opaque optimistic-concurrency token — the `updated_at` string the page
    // rendered, passed VERBATIM. Never round-trip through new Date():
    // Postgres keeps microseconds, JS truncates to milliseconds, and a
    // re-formatted token zero-row-matches on every save (silent total outage).
    expected_updated_at: z.string().min(1).max(64),
  })
  .refine((v) => (v.latitude === null) === (v.longitude === null), {
    message: 'Latitude and longitude must be set together',
  })

export type IdEditInput = z.infer<typeof idEditBaseSchema>

/** The unvalidated wire shape the edit UI submits. */
export interface IdEditSubmission {
  geo_address: string
  latitude: number | null
  longitude: number | null
  waste_types: string[]
  volume: string
  photo_urls: string[]
  expected_updated_at: string
}

/**
 * Validate an edit payload. `storedWasteTypes` is the booking's current
 * id_waste_types — every submitted tag must be a currently-offered
 * ID_WASTE_TYPES value OR already stored on the row.
 */
export function parseIdEdit(
  input: IdEditSubmission,
  storedWasteTypes: readonly string[],
  offeredWasteTypes: readonly string[],
): { ok: true; data: IdEditInput } | { ok: false; error: string } {
  const parsed = idEditBaseSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }
  const allowed = new Set<string>([...offeredWasteTypes, ...storedWasteTypes])
  const rogue = parsed.data.waste_types.find((t) => !allowed.has(t))
  if (rogue) {
    return { ok: false, error: `Unknown waste type: ${rogue}` }
  }
  return { ok: true, data: parsed.data }
}

/** Dedupe an array of photo URLs, preserving first-seen order. */
export function dedupePhotos(urls: readonly string[]): string[] {
  return Array.from(new Set(urls))
}

/**
 * Append-only check: every stored photo URL must survive in the new set.
 * Set semantics over deduped arrays — the SAME definition as the DB
 * trigger's `NEW.photos @> OLD.photos` (Postgres array containment is
 * set-semantics), so the two layers cannot disagree on multiplicity edges.
 */
export function photosArePreserved(
  stored: readonly string[],
  next: readonly string[],
): boolean {
  const nextSet = new Set(next)
  return stored.every((url) => nextSet.has(url))
}

/** Order-insensitive equality for id_waste_types (tile render order must
 *  never register as a change). */
export function wasteTypesEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false
  const bs = new Set(b)
  return a.every((t) => bs.has(t)) && new Set(a).size === bs.size
}

/**
 * Whether the crew-facing label changed MATERIALLY: trim + collapse internal
 * whitespace + case-insensitive. Cosmetic cleanups must never fire the
 * pin-stale confirm — staff trained to click through a crying-wolf dialog
 * won't read it the one time it matters (VIN-YVMSIN class).
 */
export function addressMateriallyChanged(
  before: string | null,
  after: string,
): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  return norm(before ?? '') !== norm(after)
}
