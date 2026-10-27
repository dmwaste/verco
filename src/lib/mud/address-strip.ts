/**
 * MUD address prefix stripping for Flow 5 (resident MUD-unit address redirect).
 *
 * When a resident enters "Unit 5 / 123 Broome St, Cottesloe" into the public
 * booking form, we want to look up the base building "123 Broome St, Cottesloe"
 * and check if it's an MUD. If so, the resident is blocked from booking
 * individually and redirected to contact their strata manager.
 *
 * The regex strips a leading unit/apt/lot prefix token and any separator
 * (slash, comma, whitespace) before the base address.
 *
 * Supported prefixes (case-insensitive):
 *   Unit, U, Apt, Apt., Apartment, Flat, Lot, Townhouse, Villa, Shop, Suite, #
 *
 * Examples:
 *   "Unit 5 / 123 Broome St"        → "123 Broome St"
 *   "U12/123 Broome St"             → "123 Broome St"
 *   "Apt 5A, 123 Broome St"         → "123 Broome St"
 *   "Townhouse 3/45 Broome St"      → "45 Broome St"
 *   "#5 / 123 Broome St"            → "123 Broome St"
 *   "123 Broome St" (no prefix)     → "123 Broome St" (unchanged)
 *   "4/12 Broome St" (slash, no kw) → "4/12 Broome St" (unchanged — falls through)
 */

const PREFIX_REGEX = /^\s*(u(?:nit)?|apt\.?|apartment|flat|lot|townhouse|villa|shop|suite|#)\s*[\w-]+\s*[/,]?\s*/i

export function stripAddressPrefix(addr: string): string {
  if (!addr) return addr
  return addr.replace(PREFIX_REGEX, '')
}

const UNIT_NUMBER_REGEX = /^\s*\d+[a-z]?\s*\/\s*/i

/**
 * Strips a bare unit number ("4/12 Broome St" → "12 Broome St") — the form
 * stripAddressPrefix deliberately leaves alone. Used only to find the MUD
 * building behind an admin-retired unit row (address-form.tsx), never to
 * widen a resident's own search: "4/12" and "12" are different properties
 * until an admin retires the unit.
 */
export function stripUnitNumber(addr: string): string {
  if (!addr) return addr
  return addr.replace(UNIT_NUMBER_REGEX, '')
}
