// scripts/lib/kwn-address.ts
/**
 * Robust KWN address key: `<streetNumber> <firstStreetWord> <suburb> <postcode>`.
 * Deliberately drops the street TYPE (Way/St/Pkwy/Loop…) and any directional
 * suffix, because Verco stores the Google-geocoded address (which abbreviates
 * variably and sometimes adds "E"/"S") while the Airtable master stores the raw
 * address. A false match would need two different streets to share a first word
 * AND number in the same suburb+postcode — effectively impossible. Returns null
 * if the address can't be parsed (no 4-digit postcode).
 */
export function addrKey(a: string): string | null {
  let t = a
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\bWESTERN AUSTRALIA\b/g, 'WA')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
  if (t[0] === 'UNIT') t = t.slice(1) // Verco "Unit 1/12 Edmund Way" ↔ master "1/12 Edmund Way"
  if (t.length < 4) return null
  const pc = t[t.length - 1]!
  if (!/^\d{4}$/.test(pc)) return null
  let si = t.length - 2
  if (t[si] === 'WA') si-- // token before the state is the suburb
  const suburb = t[si] ?? ''
  // Street number = first digit-leading token (also skips a leading building
  // name, e.g. master "BLACKWOOD 8 Maydwell Way" ↔ Verco "8 Maydwell Way").
  // Handles unit forms "1/12" and suffixed numbers "27A" (both start with a digit).
  const ni = t.findIndex((tok) => /^\d/.test(tok))
  if (ni < 0 || ni >= si) return null
  return `${t[ni]} ${t[ni + 1] ?? ''} ${suburb} ${pc}`
}
