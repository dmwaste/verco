/**
 * Address-matching helpers for the public booking flow's ILIKE fallback.
 *
 * The booking form's primary lookup is a `google_place_id` exact match. When
 * that misses (~36% of VV addresses — unit/MUD properties where Geocoding API
 * and Places Autocomplete return divergent place_ids), the flow falls through
 * to an ILIKE on `formatted_address`. For that fallback to work reliably we
 * need to produce a matching key from the resident's autocomplete description
 * — but Google's two APIs disagree on canonical form in two ways:
 *
 *   1. Street-type abbreviation: Geocoding returns `St`/`Ave`/`Rd`; Places
 *      Autocomplete returns the full `Street`/`Avenue`/`Road`. Geocoding is
 *      also inconsistent — some street names keep the long form (`Terrace`,
 *      `Esplanade`).
 *   2. Premise prefix: Geocoding sometimes prepends `Unit `/`Flat `/
 *      `Townhouse ` to the formatted_address; Autocomplete never does. The
 *      stored side strips these at write time (geocode-properties EF) — see
 *      `stripPremisePrefix` there.
 *
 * Because (1) is inconsistent, callers should try BOTH the raw key and the
 * normalised key; either may match depending on which side Google abbreviated.
 */

// Long-form → abbreviation. Each entry is one address shape that the DB
// stores as the abbreviation but Google Autocomplete returns as the long
// form. Without the mapping the normalised lookup is a no-op and the
// resident sees "Not eligible" despite the property being on the roll.
//
// New additions are justified by counts on the KWN tenant (the canonical
// long-tail tenant for WA street types):
//   close (216) loop (258) way (555) parkway (314) circle (357)
//   vista (121) grove (137)
//
// The dual-lookup pattern in buildLookupCandidates tries BOTH the raw
// input and the normalised form, so adding an entry never hurts the
// long-form-in-DB case — only helps the abbreviation-in-DB case.
const STREET_TYPES: Record<string, string> = {
  street: 'St',
  avenue: 'Ave',
  road: 'Rd',
  place: 'Pl',
  court: 'Ct',
  drive: 'Dr',
  crescent: 'Cres',
  boulevard: 'Blvd',
  terrace: 'Tce',
  esplanade: 'Esp',
  highway: 'Hwy',
  parade: 'Pde',
  lane: 'Ln',
  square: 'Sq',
  circuit: 'Cct',
  close: 'Cl',
  loop: 'Lp',
  way: 'Wy',
  parkway: 'Pkwy',
  circle: 'Cir',
  vista: 'Vis',
  grove: 'Grv',
}

/**
 * Reduces a Google-style formatted address to its first two comma parts
 * (street + suburb-state). This is what the booking flow prefix-matches
 * against `formatted_address` so ILIKE requires suburb agreement, not just
 * street.
 *
 *   "10 Casserley Way, Orelia WA 6167, Australia" → "10 Casserley Way, Orelia WA 6167"
 */
export function addressMatchKey(s: string): string {
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`
  return parts[0] ?? s
}

/**
 * Builds the ILIKE pattern used to match `eligible_properties.formatted_address`.
 *
 * **Anchored at the start, NOT a contains.** Stored `formatted_address` values
 * always start with the house number (the `geocode-properties` EF strips
 * premise prefixes at write time), so prefix-matching is correct.
 *
 * The original implementation used `%{key}%` (contains), which created a
 * silent house-number-substring collision: a search for `"32 Lake St, Perth WA"`
 * would match `"232 Lake St, Perth WA 6000, Australia"` because `"232"`
 * contains `"32"`. With a single matching row downstream, the resident saw a
 * "Property found!" confirmation pointing at a completely different house.
 * See VER-214 / PR for the live repro.
 *
 * Escapes `%`, `_`, and `\` in the key so a literal underscore in an address
 * (rare) doesn't become a wildcard.
 */
export function buildAddressIlikePattern(key: string): string {
  const escaped = key.replace(/[%_\\]/g, (c) => `\\${c}`)
  return `${escaped}%`
}

/**
 * Normalises full-form street types to their abbreviations (`Street` → `St`,
 * `Avenue` → `Ave`, etc.) at the END of the first comma-separated segment.
 * Only the last (or second-to-last, when followed by a directional modifier
 * like `North`/`South`) word is touched, so street NAMES that happen to be
 * street-type words (`5/2 Court Place`) aren't mangled.
 *
 *   "10 Casserley Way, Orelia WA 6167"      → "10 Casserley Wy, Orelia WA 6167"
 *   "10 Salvado Street, Wembley WA 6014"    → "10 Salvado St, Wembley WA 6014"
 *   "4D Rennie Crescent North, Hilton WA"   → "4D Rennie Cres North, Hilton WA"
 *   "5/2 Court Place, Subiaco WA"           → "5/2 Court Pl, Subiaco WA"
 *   "3 Eliot Close, Parmelia WA 6167"       → "3 Eliot Cl, Parmelia WA 6167"
 */
export function normaliseStreetTypes(s: string): string {
  const commaIdx = s.indexOf(',')
  const firstPart = commaIdx === -1 ? s : s.slice(0, commaIdx)
  const rest = commaIdx === -1 ? '' : s.slice(commaIdx)

  const words = firstPart.trim().split(/\s+/)
  if (words.length === 0) return s

  const tryReplace = (idx: number): boolean => {
    const w = words[idx]
    if (!w) return false
    const key = w.toLowerCase()
    if (key in STREET_TYPES) {
      words[idx] = STREET_TYPES[key]!
      return true
    }
    return false
  }

  // Try the last word first; if it's a directional modifier, try one earlier.
  if (!tryReplace(words.length - 1) && words.length >= 2) {
    tryReplace(words.length - 2)
  }

  return words.join(' ') + rest
}

/**
 * Builds an ordered list of distinct lookup candidates for a resident's input.
 * The caller tries each in turn (place_id match on the first, ILIKE-only on
 * the rest) until one resolves.
 *
 * The order is significant — most-specific first:
 *   1. Raw input (matches when Geocoding kept the long form, e.g. `Terrace`)
 *   2. Premise-stripped (`Unit 5 / 18 X` → `18 X`) — existing MUD pathway
 *   3. Street-type-normalised (`Street` → `St`) — catches Geocoding abbreviation
 *   4. Both transforms applied
 */
export function buildLookupCandidates(
  input: string,
  stripPrefix: (s: string) => string
): string[] {
  const out: string[] = [input]
  const stripped = stripPrefix(input)
  if (stripped !== input) out.push(stripped)

  const normalised = normaliseStreetTypes(input)
  if (normalised !== input && !out.includes(normalised)) out.push(normalised)

  if (stripped !== input) {
    const both = normaliseStreetTypes(stripped)
    if (!out.includes(both)) out.push(both)
  }
  return out
}
