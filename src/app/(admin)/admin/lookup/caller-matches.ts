import type { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/supabase/types'
import { err, ok, type Result } from '@/lib/result'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

// The busiest shared mobile on file has 11 contacts; these caps only bound a
// pathological number, they never trim a real caller.
const MAX_CONTACTS = 25
const MAX_ROWS = 200

export interface CallerBooking {
  id: string
  ref: string
  status: Database['public']['Enums']['booking_status']
  areaCode: string | null
  /** Distinct YYYY-MM-DD collection dates across the booking's items, ascending. */
  collectionDates: string[]
  address: string | null
}

export interface CallerTicket {
  id: string
  displayId: string
  subject: string
  status: Database['public']['Enums']['ticket_status']
  createdAt: string
}

export interface CallerMatch {
  contact: { id: string; fullName: string; mobile: string | null; email: string }
  /** Newest first. */
  bookings: CallerBooking[]
  /** Newest first. */
  tickets: CallerTicket[]
}

/**
 * Every contact on the caller's number, each with their bookings and service
 * tickets (VER-316).
 *
 * Scoped by RLS alone: staff reach a contact through its bookings / tickets,
 * already narrowed to their council (and sub-client). Deliberately NOT
 * getCurrentAdminClient() — the lookup answers "who is ringing" across every
 * client the user may see, so a VV caller isn't missed while the switcher sits
 * on KWN. A failed read is an error, never an empty list: "no Verco contact"
 * would send Kim to book the caller in as a new resident.
 */
export async function loadCallerMatches(
  supabase: SupabaseServerClient,
  candidates: string[],
): Promise<Result<CallerMatch[]>> {
  const { data: contacts, error } = await supabase
    .from('contacts')
    .select('id, full_name, mobile_e164, email')
    .in('mobile_e164', candidates)
    .order('full_name')
    .limit(MAX_CONTACTS)
  if (error) return err(`Couldn't search contacts: ${error.message}`)
  if (contacts.length === 0) return ok([])

  const contactIds = contacts.map((c) => c.id)
  const [bookings, tickets] = await Promise.all([
    supabase
      .from('booking')
      .select(
        `id, ref, status, contact_id, geo_address,
         collection_area(code),
         eligible_properties:property_id(formatted_address, address),
         booking_item(collection_date(date))`,
      )
      .in('contact_id', contactIds)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS),
    supabase
      .from('service_ticket')
      .select('id, display_id, subject, status, created_at, contact_id')
      .in('contact_id', contactIds)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS),
  ])
  if (bookings.error) return err(`Couldn't load bookings: ${bookings.error.message}`)
  if (tickets.error) return err(`Couldn't load service tickets: ${tickets.error.message}`)

  return ok(
    contacts.map((c) => ({
      contact: { id: c.id, fullName: c.full_name, mobile: c.mobile_e164, email: c.email },
      bookings: bookings.data
        .filter((b) => b.contact_id === c.id)
        .map((b) => ({
          id: b.id,
          ref: b.ref,
          status: b.status,
          areaCode: b.collection_area?.code ?? null,
          collectionDates: [
            ...new Set(
              b.booking_item.flatMap((item) => (item.collection_date ? [item.collection_date.date] : [])),
            ),
          ].sort(),
          address:
            b.eligible_properties?.formatted_address ??
            b.eligible_properties?.address ??
            b.geo_address,
        })),
      tickets: tickets.data
        .filter((t) => t.contact_id === c.id)
        .map((t) => ({
          id: t.id,
          displayId: t.display_id,
          subject: t.subject,
          status: t.status,
          createdAt: t.created_at,
        })),
    })),
  )
}
