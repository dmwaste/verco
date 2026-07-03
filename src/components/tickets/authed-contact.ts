import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

export interface AuthedContact {
  first_name: string
  last_name: string
  email: string
}

/**
 * Resolve the signed-in resident's contact via a SPLIT query — never an
 * embedded `profiles.contacts(...)` select.
 *
 * The embed silently returns an empty inner for authed users (the `contacts`
 * multi-FK embed gotcha, CLAUDE.md §21 — the same reason the server ticket page
 * fetches the contact separately). When that inner came back empty, the ticket
 * form lost the resident's real name and fell back to their email local-part,
 * which the create-ticket EF then wrote back over their existing contact,
 * corrupting it to "<email-local-part> -".
 *
 * Reads `profiles.contact_id`, then the contact row directly (permitted by the
 * `contacts_resident_select` policy: `id = current_user_contact_id()`). Returns
 * null when the profile isn't linked to a contact yet — the caller keeps its
 * name-capture fallback for that genuinely-unlinked case.
 */
export async function fetchAuthedTicketContact(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<AuthedContact | null> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('contact_id')
    .eq('id', userId)
    .single()

  if (!profile?.contact_id) return null

  const { data: contact } = await supabase
    .from('contacts')
    .select('first_name, last_name, email')
    .eq('id', profile.contact_id)
    .maybeSingle()

  return contact ?? null
}
