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

// A unit word only counts as a street segment when a unit number follows it —
// "Unit 1/504 Stirling Hwy" and "Unit B/41 Harvest Rd" are street addresses;
// "Villa Roma" is a premise name.
const UNIT_WORD_THEN_NUMBER =
  /^(Unit|Flat|Townhouse|Apartment|Suite|Apt|Villa)\s+(?=\d|[A-Za-z]{1,2}\/)/i

/**
 * Normalises Google's formatted_address so it starts with the house number —
 * the invariant the booking flow's start-anchored ILIKE lookup depends on
 * (see address-match-key.ts).
 *
 * Google returns two premise-prefixed shapes for strata properties:
 *   "Unit 1/504 Stirling Hwy, …"                    — bare unit word
 *   "Peppermint Close, Unit 1/504 Stirling Hwy, …"  — named premise (BR-0035)
 *
 * For the named-premise form, the leading segment is dropped only when it
 * carries no leading street number AND the next segment is recognisably the
 * street address (starts with a unit word or a number) — so "Lot 12 …" and
 * rural named properties, whose following segment is the suburb, are never
 * touched.
 */
export function stripPremisePrefix(s: string): string {
  const segments = s.split(',')
  const first = (segments[0] ?? '').trim()
  const second = (segments[1] ?? '').trim()
  if (
    segments.length > 1 &&
    first !== '' &&
    !/^\d/.test(first) &&
    !UNIT_WORD_THEN_NUMBER.test(first) &&
    (/^\d/.test(second) || UNIT_WORD_THEN_NUMBER.test(second))
  ) {
    s = segments.slice(1).join(',').trimStart()
  }
  return s.replace(UNIT_WORD_THEN_NUMBER, '')
}
