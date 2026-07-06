import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DashboardClient } from './dashboard-client'

export default async function DashboardPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth')
  }

  // Fetch profile with contact join for authoritative name
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, contact_id, contacts(full_name)')
    .eq('id', user.id)
    .single()

  // Resolve display name: contacts.full_name → email prefix
  const contactRow = profile?.contacts as { full_name: string } | null
  const displayName = contactRow?.full_name
    ?? user.email?.split('@')[0]
    ?? ''

  // Fetch current FY
  const { data: fy } = await supabase
    .from('financial_year')
    .select('id, label')
    .eq('is_current', true)
    .single()

  // Fetch bookings — filter by user's contact_id to show only their own bookings
  // (RLS allows staff to see all client bookings, but the personal dashboard should be scoped)
  const contactId = profile?.contact_id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bookings: any[] | null = null
  // Track the resolved contact so tickets can be scoped the same way as bookings
  let resolvedContactId: string | null = contactId ?? null

  if (contactId) {
    const { data } = await supabase
      .from('booking')
      .select(
        `
        id,
        ref,
        status,
        type,
        location,
        notes,
        created_at,
        geo_address,
        collection_area!inner(name),
        eligible_properties(formatted_address),
        booking_item(
          id,
          no_services,
          is_extra,
          unit_price_cents,
          service!inner(name),
          collection_date!inner(date)
        )
      `
      )
      .eq('fy_id', fy?.id ?? '')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
    bookings = data
  } else if (user.email) {
    // Fallback: match by email for users without profile→contact link
    const { data: contactByEmail } = await supabase
      .from('contacts')
      .select('id')
      .eq('email', user.email)
      .maybeSingle()

    if (contactByEmail) {
      resolvedContactId = contactByEmail.id
      const { data } = await supabase
        .from('booking')
        .select(
          `
          id,
          ref,
          status,
          type,
          location,
          notes,
          created_at,
          geo_address,
          collection_area!inner(name),
          eligible_properties(formatted_address),
          booking_item(
            id,
            no_services,
            is_extra,
            unit_price_cents,
            service!inner(name),
            collection_date!inner(date)
          )
        `
        )
        .eq('fy_id', fy?.id ?? '')
        .eq('contact_id', contactByEmail.id)
        .order('created_at', { ascending: false })
      bookings = data
    }
  }

  // Fetch the user's own service tickets — scope by contact_id, exactly like the
  // bookings query above. RLS lets staff/admin roles read ALL client tickets, so
  // the personal dashboard must filter explicitly rather than rely on RLS alone.
  const { data: tickets } = resolvedContactId
    ? await supabase
        .from('service_ticket')
        .select('id, display_id, subject, status, category, created_at')
        .eq('contact_id', resolvedContactId)
        .order('created_at', { ascending: false })
        .limit(20)
    : { data: null }

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <DashboardClient
        displayName={displayName}
        fyLabel={fy?.label ?? ''}
        bookings={bookings ?? []}
        tickets={tickets ?? []}
      />
    </main>
  )
}
