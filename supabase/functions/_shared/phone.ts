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

/** Accepts mobile / landline / 1300 / 1800 / 13xx / international. Rejects letters, too-short, +0. */
export function isValidPhone(s: string): boolean {
  const v = normalisePhone(s.trim())
  return /^\+?\d{6,15}$/.test(v) && !v.startsWith('+0')
}

/**
 * Canonicalise an AU mobile written in any common form to E.164 (+614…), or null
 * when the input is not an AU mobile. Extends normaliseAuMobile with the written
 * variants it doesn't cover: dot separators, the 00 international prefix, and the
 * redundant national zero after the country code ("+61 0412 …").
 * MUST stay the single mobile-detection used by BOTH the UI hint (isSmsCapable)
 * and every store transform — two brains here is how VER-315 happened.
 */
export function canonicaliseAuMobile(s: string): string | null {
  const v = normalisePhone(s.trim())
    .replace(/^00/, '+') // 0061… → +61…
    .replace(/^(\+?61)0(?=4)/, '$1') // +61 0412… → +61412…
  return normaliseAuMobile(v)
}

/** SMS-capable = AU mobile only. Drives the "won't receive SMS" hint. */
export const isSmsCapable = (s: string): boolean => canonicaliseAuMobile(s) !== null
