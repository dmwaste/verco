import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { STAFF_ROLES } from '@/lib/auth/roles'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { loadPropertyNotes } from '@/lib/property-notes/load'
import { CallerLookupView } from './caller-lookup-view'
import { loadCallerMatches } from './caller-matches'
import { phoneLookupCandidates } from './phone-lookup'

interface CallerLookupPageProps {
  searchParams: Promise<{ phone?: string | string[] }>
}

/**
 * Caller lookup (VER-316): the Teams "open apps in browser for incoming PSTN
 * calls" target, https://admin.verco.au/admin/lookup?phone={phone}. Shows who
 * is ringing across every client the user can see; RLS does the scoping.
 *
 * Staff only, checked before any contact query: the admin host's proxy already
 * blocks other roles, but on a tenant subdomain the (admin) layout has no role
 * guard, and field/ranger must never receive contact PII.
 */
export default async function CallerLookupPage({ searchParams }: CallerLookupPageProps) {
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  if (!STAFF_ROLES.some((r) => r === role)) redirect('/')

  const { phone } = await searchParams
  const query = (Array.isArray(phone) ? phone[0] : phone) ?? ''
  const candidates = phoneLookupCandidates(query)
  const result = candidates.length > 0 ? await loadCallerMatches(supabase, candidates) : null
  const matches = result?.ok ? result.data : []
  const propertyIds = [
    ...new Set(matches.flatMap((m) => m.bookings.flatMap((b) => (b.propertyId ? [b.propertyId] : [])))),
  ]
  const [newBookingClient, propertyNotes] = await Promise.all([
    // Only a miss offers "+ New Booking", and only it needs the switcher's council.
    result?.ok && matches.length === 0 ? getCurrentAdminClient() : null,
    // Access notes on the callers' properties (VER-321), across councils by RLS.
    loadPropertyNotes(supabase, propertyIds),
  ])

  return (
    <CallerLookupView
      query={query}
      candidates={candidates}
      result={result}
      newBookingClientName={newBookingClient?.name ?? null}
      propertyNotes={propertyNotes}
    />
  )
}
