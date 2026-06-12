/**
 * Formats a client's member-council names into the card's recognition line.
 *
 * The FULL LGA name is shown ("City of Fremantle", not "Fremantle") so a
 * resident can't mistake the council scope for a same-named suburb. Names are
 * sorted by their place name (prefix ignored) so a resident can still scan for
 * their locality. Returns null when there are no members (single-LGA clients
 * like Kwinana get no line).
 *
 *   []                                   → null
 *   ['City of Vincent']                  → 'Serving City of Vincent.'
 *   ['Town of Cambridge','City of …']    → 'Serving Town of Cambridge & City of ….'
 *   3+                                   → 'Serving A, B & C.'
 */
const LGA_PREFIX = /^(?:City|Town|Shire) of\s+/i

/** Place name without the LGA-type prefix — used only as the sort key. */
export function stripLgaPrefix(name: string): string {
  return name.replace(LGA_PREFIX, '').trim()
}

export function formatServingLine(names: string[]): string | null {
  const councils = names
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .sort((a, b) => stripLgaPrefix(a).localeCompare(stripLgaPrefix(b)))

  if (councils.length === 0) return null
  if (councils.length === 1) return `Serving ${councils[0]}.`

  const last = councils[councils.length - 1]
  const rest = councils.slice(0, -1)
  return `Serving ${rest.join(', ')} & ${last}.`
}
