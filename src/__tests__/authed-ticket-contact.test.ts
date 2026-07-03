import { describe, it, expect } from 'vitest'
import { fetchAuthedTicketContact } from '@/components/tickets/authed-contact'

/**
 * Guards the fix for the corrupted-resident-name bug: the ticket form used to
 * read the contact via an embedded `profiles.contacts(...)` select, which
 * silently returns empty for authed users (contacts multi-FK embed gotcha). The
 * empty inner dropped the real name → the form's email-prefix fallback fired →
 * create-ticket wrote "<email-local-part> -" back over the resident's contact.
 *
 * These assert the resolver does a SPLIT query (profiles.contact_id, then a
 * direct contacts read) and never touches an embed, so a revert to the embed
 * pattern fails here.
 */

interface QueryLog {
  table: string
  columns: string
}

function makeSupabase(opts: {
  contactId: string | null
  contactRow: { first_name: string; last_name: string; email: string } | null
}) {
  const queries: QueryLog[] = []
  const from = (table: string) => {
    const log: QueryLog = { table, columns: '' }
    const builder = {
      select(columns: string) {
        log.columns = columns
        queries.push(log)
        return builder
      },
      eq() {
        return builder
      },
      single() {
        return Promise.resolve({ data: { contact_id: opts.contactId } })
      },
      maybeSingle() {
        return Promise.resolve({ data: opts.contactRow })
      },
    }
    return builder
  }
  return { queries, from }
}

describe('fetchAuthedTicketContact', () => {
  it('resolves the real name via a split query — profiles.contact_id then contacts', async () => {
    const supabase = makeSupabase({
      contactId: 'contact-1',
      contactRow: {
        first_name: 'Jessica',
        last_name: 'Ramsay',
        email: 'jessica.a.ramsay@gmail.com',
      },
    })

    // @ts-expect-error — minimal builder mock, not a full SupabaseClient
    const contact = await fetchAuthedTicketContact(supabase, 'user-1')

    expect(contact).toEqual({
      first_name: 'Jessica',
      last_name: 'Ramsay',
      email: 'jessica.a.ramsay@gmail.com',
    })

    // Two separate queries — NOT a single embedded `profiles.contacts(...)`.
    expect(supabase.queries.map((q) => q.table)).toEqual(['profiles', 'contacts'])
    const profilesQuery = supabase.queries.find((q) => q.table === 'profiles')!
    expect(profilesQuery.columns).toBe('contact_id')
    expect(profilesQuery.columns).not.toContain('contacts(')
  })

  it('returns null when the profile has no linked contact (fallback territory)', async () => {
    const supabase = makeSupabase({ contactId: null, contactRow: null })

    // @ts-expect-error — minimal builder mock, not a full SupabaseClient
    const contact = await fetchAuthedTicketContact(supabase, 'user-1')

    expect(contact).toBeNull()
    // Must not attempt the contacts read when there's no contact_id.
    expect(supabase.queries.map((q) => q.table)).toEqual(['profiles'])
  })

  it('returns null when the contact row is missing despite a contact_id', async () => {
    const supabase = makeSupabase({ contactId: 'contact-1', contactRow: null })

    // @ts-expect-error — minimal builder mock, not a full SupabaseClient
    const contact = await fetchAuthedTicketContact(supabase, 'user-1')

    expect(contact).toBeNull()
  })
})
