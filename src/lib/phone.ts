/**
 * AU phone helpers — the single brain for phone validation, canonicalisation,
 * and SMS-capability detection (VER-315, #457).
 *
 * Mirror pair: supabase/functions/_shared/phone.ts (SOURCE — edit here) →
 * src/lib/phone.ts, kept in sync by scripts/sync-mirrors.sh.
 *
 * Store rule (every write path): mobiles → E.164 (+614…) so SMS sends work;
 * landlines / 1300 / international → formatting-stripped as entered. SMS
 * dispatch guards on /^\+614\d{8}$/ and skips non-mobiles cleanly, so a
 * stored landline is valid contact data, never a send failure.
 */

/**
 * Normalise an Australian mobile number to E.164 format (+614XXXXXXXX).
 * Accepts: 04XXXXXXXX, +614XXXXXXXX, 614XXXXXXXX
 * Returns null if invalid.
 */
export function normaliseAuMobile(raw: string): string | null {
  const digits = raw.replace(/[\s\-()]+/g, '')

  // +614XXXXXXXX (already E.164)
  if (/^\+614\d{8}$/.test(digits)) return digits
  // 614XXXXXXXX (missing +)
  if (/^614\d{8}$/.test(digits)) return `+${digits}`
  // 04XXXXXXXX (local format)
  if (/^04\d{8}$/.test(digits)) return `+61${digits.slice(1)}`

  return null
}

/**
 * Format an E.164 AU mobile for display: 04XX XXX XXX
 */
export function formatAuMobileDisplay(e164: string): string {
  // +614XXXXXXXX → 04XX XXX XXX
  const local = '0' + e164.replace('+61', '')
  if (local.length !== 10) return e164
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
}

/** Strip phone formatting (spaces, parens, hyphens, dots) but keep a leading +. */
export const normalisePhone = (s: string) => s.replace(/[\s()\-.]/g, '')

/** The field error every phone input shows when isValidPhone rejects it. */
export const PHONE_INVALID_MESSAGE =
  'Check your number. Mobiles are 10 digits (04xx xxx xxx); landlines need the area code (08 xxxx xxxx).'

/**
 * Accepts mobile / landline / 1300 / 1800 / 13xx / international. Rejects letters,
 * too-short, +0, and an Australian-looking number with the wrong digit count (#668:
 * `0413 12345` passed, was stored raw, and the resident silently got no SMS).
 * Another country's number keeps the loose 6–15-digit rule.
 */
export function isValidPhone(s: string): boolean {
  const v = normalisePhone(s.trim())
  return /^\+?\d{6,15}$/.test(v) && !v.startsWith('+0') && hasAuLength(v.replace(/^00/, '+'))
}

function hasAuLength(v: string): boolean {
  if (/^\+?61/.test(v)) return /^\+?610?[1-9]\d{8}$/.test(v) // +61 [0] + 9 digits
  if (v.startsWith('+')) return true
  if (/^0[2-478]/.test(v) || /^1[38]00/.test(v)) return v.length === 10 // 04 mobile, 0[2378] landline
  if (v.startsWith('4')) return v.length === 9 // 412… (no 0), canonicalised to +614…
  if (v.startsWith('13')) return v.length === 6
  return v.length !== 8 // a local number with the area code left off
}

/**
 * Canonicalise an AU mobile written in any common form to E.164 (+614…), or null
 * when the input is not an AU mobile. Extends normaliseAuMobile with the written
 * variants it doesn't cover: dot separators, the 00 international prefix, the
 * redundant national zero after the country code ("+61 0412 …"), the leading 0
 * left off ("412 …"), and a saved 04 mobile that browser autofill re-prefixed for
 * a UK or US region ("+44 412 …", "+1 0412 …" — neither is a valid UK/NANP
 * number, so they can only be an AU mobile; 18/10/2026 these were stored raw and
 * the residents got no SMS).
 * MUST stay the single mobile-detection used by BOTH the UI hint (isSmsCapable)
 * and every store transform — two brains here is how VER-315 happened.
 */
export function canonicaliseAuMobile(s: string): string | null {
  const v = normalisePhone(s.trim())
    .replace(/^00/, '+') // 0061… → +61…
    .replace(/^(\+?61)0(?=4)/, '$1') // +61 0412… → +61412…
    .replace(/^(?:\+44(?=4\d{8}$)|\+1(?=04\d{8}$))/, '') // autofill: +44 412… / +1 0412… → 412… / 0412…
    .replace(/^4\d{8}$/, '0$&') // 412… → 0412…
  return normaliseAuMobile(v)
}

/** SMS-capable = AU mobile only. Drives the "won't receive SMS" hint. */
export const isSmsCapable = (s: string): boolean => canonicaliseAuMobile(s) !== null
