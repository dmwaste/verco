/**
 * Street-number agreement check for geocode results.
 *
 * Google's Geocoding API "snaps" addresses it doesn't know to the nearest
 * parcel it does know. For a freshly subdivided lot ("16A Bolsover St" where
 * Google still only has the parent "16 Bolsover St"), it silently returns the
 * PARENT's formatted_address and place_id. If the geocoder adopts that result,
 * the child row's identity is destroyed: the booking flow, admin lists, and
 * OptimoRoute all display `formatted_address ?? address`, so the resident's
 * correct "16A" selection renders as "16" everywhere — and the parent's
 * place_id ends up shared across sibling rows, corrupting the primary
 * place_id lookup (16 Bolsover St, Wellard incident, 08/2026).
 *
 * The precise signal for this class is the street-number token: the leading
 * digit-bearing word of the first comma segment ("16A", "5/123", "12"). When
 * the input's token and Google's token disagree, the result describes a
 * DIFFERENT premise and must not overwrite the row's identity columns.
 */

/**
 * Extracts the street-number token from an address string: the first
 * whitespace-delimited word containing a digit, within the first comma
 * segment only (so postcodes/suburb numbers never match). Uppercased for
 * case-insensitive comparison ("16a" ≡ "16A"). Null when the segment has no
 * digit-bearing word (rural named properties) — callers treat that as
 * "cannot verify".
 */
export function extractStreetNumberToken(s: string): string | null {
  const segment = s.split(',')[0] ?? s
  for (const word of segment.trim().split(/\s+/)) {
    if (/\d/.test(word)) return word.toUpperCase()
  }
  return null
}

/**
 * True when both addresses carry a street number and the numbers differ —
 * positive evidence the geocode result is a different premise (parent-parcel
 * snap, dropped unit prefix, narrowed range). False when either side has no
 * street number: with no way to verify, keep the legacy trust-Google
 * behaviour rather than blocking every rural/named-property geocode.
 */
export function streetNumbersDisagree(
  inputAddress: string,
  googleFormattedAddress: string
): boolean {
  const a = extractStreetNumberToken(inputAddress)
  const b = extractStreetNumberToken(googleFormattedAddress)
  if (!a || !b) return false
  return a !== b
}
