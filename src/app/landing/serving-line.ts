/**
 * Formats a client's member-council names into the card's recognition line.
 *
 * Residents identify by their place name ("Fremantle"), not the LGA-type
 * prefix, so the leading "City of " / "Town of " / "Shire of " is stripped
 * and the names are sorted alphabetically for scanning. Returns null when
 * there are no members (single-LGA clients like Kwinana get no line).
 *
 *   []                          → null
 *   ['City of Vincent']         → 'Serving Vincent.'
 *   ['Town of X', 'City of Y']  → 'Serving X & Y.'  (sorted)
 *   3+                          → 'Serving A, B & C.'
 */
const LGA_PREFIX = /^(?:City|Town|Shire) of\s+/i

export function stripLgaPrefix(name: string): string {
  return name.replace(LGA_PREFIX, '').trim()
}

export function formatServingLine(names: string[]): string | null {
  const places = names
    .map(stripLgaPrefix)
    .filter((n) => n.length > 0)
    .sort((a, b) => a.localeCompare(b))

  if (places.length === 0) return null
  if (places.length === 1) return `Serving ${places[0]}.`

  const last = places[places.length - 1]
  const rest = places.slice(0, -1)
  return `Serving ${rest.join(', ')} & ${last}.`
}
