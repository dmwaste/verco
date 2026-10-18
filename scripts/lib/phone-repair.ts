// scripts/lib/phone-repair.ts
/**
 * Repair rules for contacts.mobile_e164 values already on file (18/10/2026
 * audit). Mobiles go through the ONE phone brain (canonicaliseAuMobile). The
 * landline rules only restore what is provably the same number: a dropped
 * trunk 0, a redundant 0 after +61, or the 08 area code on a Perth local. Every
 * contact on file is a WA resident, and all of WA is 08. Anything else is left
 * for staff to check with the resident; it is never guessed.
 */
import { canonicaliseAuMobile } from '../../src/lib/phone'

export type RepairRule =
  | 'no-number'
  | 'au-mobile'
  | 'landline-trunk-0'
  | 'landline-redundant-0'
  | 'wa-local'

export type PhoneRepair =
  | { action: 'keep' }
  | { action: 'fix'; to: string | null; rule: RepairRule }
  | { action: 'manual' }

// Valid as stored — never touched.
const VALID = [
  /^\+614\d{8}$/, // AU mobile
  /^\+61[2378]\d{8}$/, // AU landline, E.164
  /^0[2378]\d{8}$/, // AU landline, local
  /^1[38]00\d{6}$/, // 1300 / 1800
  /^13\d{4}$/, // 13 xx xx
  /^\+(?!61)[1-9]\d{6,14}$/, // international, as entered
]

export function repairStoredPhone(raw: string): PhoneRepair {
  if (!/\d/.test(raw)) return { action: 'fix', to: null, rule: 'no-number' }
  if (/^\+614\d{8}$/.test(raw)) return { action: 'keep' }

  // Before the international keep: +44 4… / +1 04… are AU mobiles, not foreign numbers.
  const mobile = canonicaliseAuMobile(raw)
  if (mobile) return { action: 'fix', to: mobile, rule: 'au-mobile' }

  if (VALID.some((re) => re.test(raw))) return { action: 'keep' }

  let m: RegExpExecArray | null
  if ((m = /^([2378]\d{8})$/.exec(raw))) return { action: 'fix', to: `0${m[1]}`, rule: 'landline-trunk-0' }
  if ((m = /^\+610([2378]\d{8})$/.exec(raw))) return { action: 'fix', to: `+61${m[1]}`, rule: 'landline-redundant-0' }
  if ((m = /^(?:\+610?)?([69]\d{7})$/.exec(raw))) return { action: 'fix', to: `08${m[1]}`, rule: 'wa-local' }

  return { action: 'manual' }
}

/** First 4 characters kept, every later digit → d: the shape, never the number. */
export const maskPhone = (s: string) =>
  s.slice(0, 4) + s.slice(4).replace(/\d/g, 'd').replace(/\s+/g, ' ')
