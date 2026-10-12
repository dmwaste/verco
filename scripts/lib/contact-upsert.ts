// scripts/lib/contact-upsert.ts
// Contact upsert helper for the MUD import script.
// Follows the same pattern as area-map.ts / verco-upsert.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { canonicaliseAuMobile, normalisePhone } from '../../src/lib/phone'
import { resolveContact } from '../../src/lib/contacts/contact-match'

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

/**
 * Booking imports: find-or-create the resident's contact for a booking at
 * `propertyId` without folding different people onto one row. Airtable phone
 * bookings carry the WMRC office email, and find-by-email put 263 residents on
 * one contact (12/10/2026). Same rule as create-booking (resolveContact), except
 * an import never edits an existing row — a same-household match is reused as-is.
 */
export async function resolveResidentContact(
  verco: SupabaseClient,
  propertyId: string,
  opts: { email: string; firstName: string; lastName: string; mobileE164: string },
): Promise<ContactUpsertResult> {
  const email = opts.email.trim().toLowerCase()
  const { data: rows, error } = await verco
    .from('contacts')
    .select('id, first_name, last_name, mobile_e164')
    .eq('email', email)
    .order('created_at', { ascending: true })
    .limit(50)
  if (error) return { contactId: null, created: false, error: error.message }

  const ids = (rows ?? []).map((r: { id: string }) => r.id)
  let elsewhere = new Set<string>()
  let strata = new Set<string>()
  if (ids.length) {
    const [b, s] = await Promise.all([
      verco.from('booking').select('contact_id').in('contact_id', ids).neq('property_id', propertyId),
      verco.from('eligible_properties').select('strata_contact_id').in('strata_contact_id', ids),
    ])
    if (b.error || s.error) return { contactId: null, created: false, error: (b.error ?? s.error)!.message }
    elsewhere = new Set((b.data ?? []).map((r: { contact_id: string }) => r.contact_id))
    strata = new Set((s.data ?? []).map((r: { strata_contact_id: string }) => r.strata_contact_id))
  }

  const resolution = resolveContact(
    (rows ?? []).map((r: { id: string; first_name: string | null; last_name: string | null; mobile_e164: string | null }) => ({
      ...r,
      bookedElsewhere: elsewhere.has(r.id),
      isStrataContact: strata.has(r.id),
    })),
    { first_name: opts.firstName, last_name: opts.lastName, mobile_e164: opts.mobileE164 },
    false,
  )
  if (resolution.action !== 'insert') return { contactId: resolution.contactId, created: false, error: null }

  const { data: created, error: insertError } = await verco
    .from('contacts')
    .insert({ first_name: opts.firstName, last_name: opts.lastName, email, mobile_e164: opts.mobileE164 })
    .select('id')
    .single()
  if (insertError) return { contactId: null, created: false, error: insertError.message }
  return { contactId: (created as { id: string }).id, created: true, error: null }
}
