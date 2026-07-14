/**
 * Parse an untrusted coordinate from eligible_properties into a finite number,
 * or null if it isn't one.
 *
 * The generated type for latitude/longitude is `number | null`, but numeric
 * columns arrive as strings on some fetch paths and imported rows can carry
 * garbage. Two coercion traps make a bare Number()/isFinite check insufficient:
 * Number('') === 0 (a "valid" pin at 0,0 in the Gulf of Guinea) and
 * Number(['-32.24']) === -32.24 (array-to-string coercion), so inputs are
 * type-gated before coercion.
 */
export function finiteCoord(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
