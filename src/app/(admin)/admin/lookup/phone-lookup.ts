import {
  canonicaliseAuMobile,
  formatAuMobileDisplay,
  isValidPhone,
  normalisePhone,
} from '@/lib/phone'

/**
 * Caller lookup (VER-316): turns whatever number reached /admin/lookup into
 * the stored forms to match on `contacts.mobile_e164`.
 *
 * Store rule (src/lib/phone.ts): mobiles are E.164, landlines are
 * formatting-stripped AS ENTERED, so a landline caller can be on file as
 * either `+618…` or `08…` and both are tried.
 */

// AU geographic landline (02/03/07/08) as +61X…, 61X…, +610X… or 0X….
const AU_LANDLINE = /^(?:\+?61)?0?([2378]\d{8})$/

/** Stored forms to match for a caller's number; empty when it isn't a phone number. */
export function phoneLookupCandidates(raw: string): string[] {
  // Teams fills `?phone={phone}` with an unencoded `+61…`, and a query-string
  // `+` decodes to a space. Put it back, but not before a 0 (a local number).
  const value = normalisePhone(raw.replace(/^\s(?=[1-9])/, '+').trim()).replace(/^00/, '+')
  if (!isValidPhone(value)) return []

  const mobile = canonicaliseAuMobile(value)
  if (mobile) return [mobile]

  const landline = AU_LANDLINE.exec(value)
  if (landline) return [`+61${landline[1]}`, `0${landline[1]}`]

  return [value]
}

/** 04XX XXX XXX for a mobile, 0X XXXX XXXX for a landline, else as stored. */
export function formatPhoneDisplay(stored: string): string {
  if (/^\+614\d{8}$/.test(stored)) return formatAuMobileDisplay(stored)
  const landline = AU_LANDLINE.exec(stored)
  if (landline) {
    const local = `0${landline[1]}`
    return `${local.slice(0, 2)} ${local.slice(2, 6)} ${local.slice(6)}`
  }
  return stored
}
