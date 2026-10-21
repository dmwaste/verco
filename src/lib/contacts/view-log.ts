import * as Sentry from '@sentry/nextjs'
import type { createClient } from '@/lib/supabase/server'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** Where a contact was opened. The 360 timeline (VER-318) adds its own value. */
export type ContactViewSurface = 'caller_lookup'

/**
 * Records that the signed-in staff member was shown these contacts (VER-322,
 * PRIS gap 7, ADR 0040): one contact_view_log row each. The database stamps
 * who and when, and RLS refuses anything else. Runs under the caller's own JWT.
 *
 * Never blocks the page — the resident is usually on the phone — so a failed
 * write goes to Sentry as a warning (no contact ids) and the page still shows.
 */
export async function logContactViews(
  supabase: ServerSupabase,
  contactIds: string[],
  surface: ContactViewSurface,
): Promise<void> {
  const ids = [...new Set(contactIds)]
  if (ids.length === 0) return

  // No .select(): staff roles may insert but not read the log.
  const { error } = await supabase
    .from('contact_view_log')
    .insert(ids.map((contact_id) => ({ contact_id, surface })))
  if (error) {
    Sentry.captureMessage('Contact view log write failed', {
      level: 'warning',
      extra: { surface, contacts: ids.length, code: error.code, error: error.message },
    })
  }
}
