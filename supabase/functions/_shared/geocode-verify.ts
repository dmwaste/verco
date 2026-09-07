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

/**
 * The state every Verco council sits in. Google returns interstate namesakes
 * for common street names ("10 Market St, Kensington" → Kensington VIC 3031)
 * and the `administrative_area` component filter is bias-only, never
 * enforced — so the result's state is checked here instead. Mirrors the
 * WA-only restriction in google-places-proxy's autocomplete.
 */
export const SERVICE_STATE = 'WA'

const AU_STATE_CODES = new Set(['WA', 'NSW', 'VIC', 'QLD', 'SA', 'TAS', 'NT', 'ACT'])

// Street-type words (long form + the abbreviations councils and Google use).
// The input's suburb candidate is whatever FOLLOWS the last of these — council
// exports have no comma ("12 Smith ST PERTH"), so the street type is the only
// reliable boundary between street name and suburb.
const STREET_TYPE_WORDS = new Set([
  'ST', 'STREET', 'RD', 'ROAD', 'AVE', 'AV', 'AVENUE', 'PL', 'PLACE', 'CT', 'COURT',
  'DR', 'DRIVE', 'CRES', 'CR', 'CRESCENT', 'BLVD', 'BVD', 'BOULEVARD', 'TCE', 'TERRACE',
  'ESP', 'ESPLANADE', 'HWY', 'HIGHWAY', 'PDE', 'PARADE', 'LN', 'LA', 'LANE', 'SQ', 'SQUARE',
  'CCT', 'CIRCUIT', 'CL', 'CLOSE', 'LP', 'LOOP', 'WY', 'WAY', 'PKWY', 'PARKWAY', 'CIR',
  'CIRCLE', 'VIS', 'VISTA', 'GRV', 'GROVE', 'GDNS', 'GARDENS', 'RISE', 'MEWS', 'ENT',
  'ENTRANCE', 'RTT', 'RETREAT', 'WALK', 'PROM', 'PROMENADE', 'BEND', 'GLEN', 'HTS',
  'HEIGHTS', 'TRL', 'TRAIL', 'TURN', 'VW', 'VIEW', 'RDGE', 'RIDGE', 'ROW', 'COVE', 'LINK',
  'MALL', 'ALLEY', 'CHASE', 'ELBOW', 'KEY', 'PASS', 'PATH', 'QUAY', 'QY', 'RAMBLE', 'REST',
  'TRACK', 'VALE', 'ARC', 'ARCADE', 'BRACE', 'BRAE', 'BROW', 'CNR', 'CORNER', 'DALE', 'EDGE',
  'FWY', 'FREEWAY', 'GATE', 'GLADE', 'GRANGE', 'HAVEN', 'HILL', 'MEANDER', 'NOOK', 'OUTLOOK',
  'PARK', 'POINT', 'PT', 'RUN', 'SPUR', 'STRAND', 'WYND',
])

/**
 * Uppercased word tokens usable for suburb comparison: punctuation stripped,
 * "MT" expanded to "MOUNT", and postcodes / state codes / "AUSTRALIA" /
 * two-letter fragments (the street-type "St" of "St James", "WA") dropped so
 * they can never manufacture an overlap.
 */
function localityWords(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .map((w) => (w === 'MT' ? 'MOUNT' : w))
    .filter(
      (w) => w.length > 2 && !/\d/.test(w) && !AU_STATE_CODES.has(w) && w !== 'AUSTRALIA'
    )
}

/**
 * The suburb candidate words of an input address. Comma-form inputs
 * ("13A Epping Way, Wellard WA 6170") use the second comma segment; bare
 * council exports ("12 Smith ST PERTH") use whatever follows the LAST
 * street-type word. Empty when no boundary can be found ("45 Pakenham St",
 * "15 goran") — callers treat that as "cannot verify".
 */
export function inputSuburbWords(inputAddress: string): string[] {
  const segments = inputAddress.split(',')
  if (segments.length > 1) return localityWords(segments[1] ?? '')
  const words = inputAddress.toUpperCase().replace(/[^A-Z0-9\/]+/g, ' ').trim().split(' ')
  let boundary = -1
  for (let i = 0; i < words.length; i++) {
    if (STREET_TYPE_WORDS.has(words[i]!)) boundary = i
  }
  if (boundary === -1) return []
  return localityWords(words.slice(boundary + 1).join(' '))
}

/**
 * True on POSITIVE evidence that Google's locality is a different suburb from
 * the one in the input — the input carries suburb words, Google named a
 * locality, and the two share no word. Word overlap is deliberately tolerant
 * ("SOUTH PERTH" vs "Perth", "MT CLAREMONT" vs "Mount Claremont") so a Google
 * naming quirk never rejects a correct geocode; this matches the booking
 * flow's `suburbsConflict` rule. Either side empty → cannot verify → false.
 *
 * The live case: "12 Smith St Perth" → Google reads "Perth" as the metro area
 * and returns "12 Smith St, Beaconsfield WA 6162" (VIN-MUD-104, 29/07/2026).
 */
export function localitiesConflict(
  inputAddress: string,
  googleLocality: string | null | undefined
): boolean {
  if (!googleLocality) return false
  const google = localityWords(googleLocality)
  const input = inputSuburbWords(inputAddress)
  if (google.length === 0 || input.length === 0) return false
  const inputSet = new Set(input)
  return !google.some((w) => inputSet.has(w))
}

/** The parts of a Geocoding API result the verifier needs. */
export type GeocodeResultShape = {
  /** Google's formatted_address, already premise-stripped. */
  formattedAddress: string
  /** result.types */
  types: string[]
  /** result.geometry.location_type */
  locationType: string | null
  /** address_components[type=locality].long_name */
  locality: string | null
  /** address_components[type=administrative_area_level_1].short_name */
  state: string | null
}

export type GeocodeVerdict =
  | { verdict: 'ok' }
  /** Different street number (parent-parcel snap): coordinates-only write. */
  | { verdict: 'snapped' }
  /** Different premise entirely: write NOTHING — the coordinates are unusable. */
  | { verdict: 'rejected'; reason: 'state' | 'granularity' | 'locality' }

// Google result types / location_types that describe an address-level premise.
// Anything else (locality, country, route, postal_code…) is a fallback Google
// returns when it can't find the street — "13A Epping Way Wellard" →
// "Wellard WA 6170", "19 Gali La City Beach" → "Australia".
const PREMISE_TYPES = new Set(['street_address', 'premise', 'subpremise'])
const PREMISE_LOCATION_TYPES = new Set(['ROOFTOP', 'RANGE_INTERPOLATED'])

/**
 * Decides what the geocoder may write for a Google result. Rejections come
 * before the snap check: a wrong-suburb result with a different number is a
 * different premise altogether, and even coordinates-only would route a crew
 * to the wrong suburb.
 */
export function verifyGeocodeResult(
  inputAddress: string,
  r: GeocodeResultShape
): GeocodeVerdict {
  if (r.state && r.state.toUpperCase() !== SERVICE_STATE) {
    return { verdict: 'rejected', reason: 'state' }
  }
  const premise =
    r.types.some((t) => PREMISE_TYPES.has(t)) ||
    (r.locationType !== null && PREMISE_LOCATION_TYPES.has(r.locationType))
  if (!premise) return { verdict: 'rejected', reason: 'granularity' }
  if (localitiesConflict(inputAddress, r.locality)) {
    return { verdict: 'rejected', reason: 'locality' }
  }
  if (streetNumbersDisagree(inputAddress, r.formattedAddress)) return { verdict: 'snapped' }
  return { verdict: 'ok' }
}
