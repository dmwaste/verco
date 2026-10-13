// EF-only helper — no src/lib mirror (only Edge Functions write contacts this way).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database, TablesInsert, TablesUpdate } from './database.types.ts'
import { resolveContact, type ContactResolution } from './contact-match.ts'
import { emailMatchPattern } from './email.ts'

export interface EnteredContact {
  first_name: string
  last_name: string
  email: string
  /** Optional on these paths; when absent, an update keeps the stored number. */
  mobile_e164?: string | null
}

/**
 * Which address the write is for. It decides which rows count as the same
 * household in resolveContact:
 *   { propertyId }  a row whose bookings are all at this property
 *   'one-address'   no address of its own (a staff-created login): a row whose
 *                   bookings reach one address at most
 *   'none'          no address at all (a ticket with no booking): no row is local,
 *                   so only the same person, or a signed-in caller's own single
 *                   row, is kept
 * A booking with no property (an ID booking) always counts as another address.
 */
export type ContactHousehold = { propertyId: string } | 'one-address' | 'none'

export type AttachContactResult =
  | { ok: true; contactId: string; action: ContactResolution['action'] }
  | { ok: false; error: string }

// One row comes back per booking, so a full page may be missing rows. Then every
// candidate counts as shared rather than risk editing one that reaches further.
const USAGE_CAP = 1000

type Usage = { elsewhere: (contactId: string) => boolean; error: { message: string } | null }

const everywhere: Usage['elsewhere'] = () => true

async function bookingUsage(
  supabase: SupabaseClient<Database>,
  ids: string[],
  household: ContactHousehold,
): Promise<Usage> {
  if (household === 'none') return { elsewhere: everywhere, error: null }

  if (household === 'one-address') {
    const { data, error } = await supabase
      .from('booking')
      .select('contact_id, property_id')
      .in('contact_id', ids)
      .limit(USAGE_CAP)
    if (error) return { elsewhere: everywhere, error }
    if ((data ?? []).length >= USAGE_CAP) return { elsewhere: everywhere, error: null }
    const addresses = new Map<string, Set<string | null>>()
    for (const b of data ?? []) {
      if (!b.contact_id) continue
      const seen = addresses.get(b.contact_id) ?? new Set<string | null>()
      seen.add(b.property_id)
      addresses.set(b.contact_id, seen)
    }
    return {
      elsewhere: (id) => {
        const seen = addresses.get(id)
        return Boolean(seen && (seen.size > 1 || seen.has(null)))
      },
      error: null,
    }
  }

  const { data, error } = await supabase
    .from('booking')
    .select('contact_id')
    .in('contact_id', ids)
    .or(`property_id.is.null,property_id.neq.${household.propertyId}`)
    .limit(USAGE_CAP)
  if (error) return { elsewhere: everywhere, error }
  if ((data ?? []).length >= USAGE_CAP) return { elsewhere: everywhere, error: null }
  const booked = new Set((data ?? []).map((b) => b.contact_id))
  return { elsewhere: (id) => booked.has(id), error: null }
}

/**
 * Finds or creates the contact for a write path that only has an email to go on
 * (create-ticket, create-user), under the ADR 0027 rule in resolveContact. These
 * paths used to overwrite whichever contact carried the email, so a ticket or a
 * new login under a shared address (the WMRC office email sat on 278 bookings)
 * rewrote every other resident's booking contact. A row is now only changed when
 * the change can't reach anyone else; otherwise the caller gets a new row.
 */
export async function attachContact(
  supabase: SupabaseClient<Database>,
  entered: EnteredContact,
  opts: { household: ContactHousehold; enteredBySelf: boolean },
): Promise<AttachContactResult> {
  const { data: sameEmail, error: lookupError } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, mobile_e164')
    .ilike('email', emailMatchPattern(entered.email))
    .order('created_at', { ascending: true })
    .limit(50)
  if (lookupError) return { ok: false, error: `Failed to look up contact: ${lookupError.message}` }

  const rows = sameEmail ?? []
  const ids = rows.map((c) => c.id)
  let elsewhere = everywhere
  let strataIds = new Set<string | null>()
  if (ids.length) {
    const [usage, strata] = await Promise.all([
      bookingUsage(supabase, ids, opts.household),
      supabase.from('eligible_properties').select('strata_contact_id').in('strata_contact_id', ids),
    ])
    const usageError = usage.error ?? strata.error
    if (usageError) return { ok: false, error: `Failed to look up contact: ${usageError.message}` }
    elsewhere = usage.elsewhere
    strataIds = new Set((strata.data ?? []).map((r) => r.strata_contact_id))
  }

  const mobile = entered.mobile_e164 || null
  const resolution = resolveContact(
    rows.map((c) => ({ ...c, bookedElsewhere: elsewhere(c.id), isStrataContact: strataIds.has(c.id) })),
    { first_name: entered.first_name, last_name: entered.last_name, mobile_e164: mobile },
    opts.enteredBySelf,
  )

  if (resolution.action === 'reuse') return { ok: true, contactId: resolution.contactId, action: 'reuse' }

  if (resolution.action === 'update') {
    // full_name is a generated column — write first/last only.
    const update: TablesUpdate<'contacts'> = { first_name: entered.first_name, last_name: entered.last_name }
    if (mobile) update.mobile_e164 = mobile
    const { error } = await supabase.from('contacts').update(update).eq('id', resolution.contactId)
    if (error) return { ok: false, error: `Failed to update contact: ${error.message}` }
    return { ok: true, contactId: resolution.contactId, action: 'update' }
  }

  const insert: TablesInsert<'contacts'> = {
    first_name: entered.first_name,
    last_name: entered.last_name,
    email: entered.email,
  }
  if (mobile) insert.mobile_e164 = mobile
  const { data: created, error: insertError } = await supabase.from('contacts').insert(insert).select('id').single()
  if (insertError || !created) {
    return { ok: false, error: `Failed to create contact: ${insertError?.message ?? 'no row returned'}` }
  }
  return { ok: true, contactId: created.id, action: 'insert' }
}
