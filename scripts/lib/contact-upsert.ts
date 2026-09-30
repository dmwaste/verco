// scripts/lib/contact-upsert.ts
// Contact upsert helper for the MUD import script.
// Follows the same pattern as area-map.ts / verco-upsert.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { canonicaliseAuMobile, normalisePhone } from '../../src/lib/phone'

/**
 * Airtable MUD List contact cells → upsertContact input. Phones go through the
 * one-brain store rule (src/lib/phone.ts, CLAUDE.md §21): AU mobiles → E.164 so
 * SMS works, landlines/other → formatting-stripped — never a local variant.
 */
export function mudContactInput(rec: { contactName: string | null; contactNumber: string | null; email: string | null }) {
  const name = rec.contactName?.trim() ?? ''
  const sp = name.indexOf(' ')
  const phone = rec.contactNumber?.trim() ?? ''
  return {
    email: rec.email?.trim() ? rec.email.trim().toLowerCase() : null,
    firstName: sp === -1 ? name : name.slice(0, sp),
    lastName: sp === -1 ? '' : name.slice(sp + 1),
    mobileE164: phone ? (canonicaliseAuMobile(phone) ?? normalisePhone(phone)) : '',
  }
}

export type ContactUpsertResult = {
  contactId: string | null
  created: boolean
  error: string | null
}

/**
 * Find an existing contact by email or create a new one.
 * Never updates an existing contact — admin may have manually corrected data.
 * Returns null contactId when no email is provided.
 */
export async function upsertContact(
  verco: SupabaseClient,
  opts: {
    email: string | null
    firstName: string
    lastName: string
    mobileE164: string
  },
  dryRun: boolean,
): Promise<ContactUpsertResult> {
  if (!opts.email?.trim()) return { contactId: null, created: false, error: null }

  const email = opts.email.trim().toLowerCase()

  const { data: existing } = await verco
    .from('contacts')
    .select('id')
    .eq('email', email)
    .limit(1)
    .maybeSingle()

  if (existing) return { contactId: (existing as { id: string }).id, created: false, error: null }

  if (dryRun) return { contactId: null, created: false, error: null }

  const { data: created, error } = await verco
    .from('contacts')
    .insert({ first_name: opts.firstName, last_name: opts.lastName, email, mobile_e164: opts.mobileE164 })
    .select('id')
    .single()

  if (error) return { contactId: null, created: false, error: error.message }
  return { contactId: (created as { id: string }).id, created: true, error: null }
}
