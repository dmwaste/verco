import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TicketDetailClient } from './ticket-detail-client'

interface TicketDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function TicketDetailPage({
  params,
}: TicketDetailPageProps) {
  const { id: displayId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth')
  }

  // RLS policy service_ticket_resident_select ensures only the owner's tickets are returned
  const { data: ticket } = await supabase
    .from('service_ticket')
    .select(
      `
      id,
      display_id,
      subject,
      message,
      status,
      priority,
      category,
      channel,
      booking_id,
      created_at,
      updated_at
    `
    )
    .eq('display_id', displayId)
    .single()

  if (!ticket) {
    redirect('/dashboard')
  }

  // Fetch responses (RLS filters out is_internal = true for residents)
  const { data: responses } = await supabase
    .from('ticket_response')
    .select(
      `
      id,
      author_id,
      author_type,
      message,
      is_internal,
      created_at
    `
    )
    .eq('ticket_id', ticket.id)
    .order('created_at', { ascending: true })

  // Fetch author names for staff responses
  const staffAuthorIds = [
    ...new Set(
      (responses ?? [])
        .filter((r) => r.author_type === 'staff')
        .map((r) => r.author_id)
    ),
  ]

  let staffNames: Record<string, string> = {}
  if (staffAuthorIds.length > 0) {
    const { data: staffProfiles } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', staffAuthorIds)

    if (staffProfiles) {
      staffNames = Object.fromEntries(
        staffProfiles.map((p) => [p.id, p.display_name ?? 'Support'])
      )
    }
  }

  // Fetch linked booking details if present
  let linkedBooking: {
    ref: string
    address: string
    collectionDate: string | null
    services: string[]
  } | null = null

  if (ticket.booking_id) {
    const { data: booking } = await supabase
      .from('booking')
      .select(
        `
        ref,
        eligible_properties(formatted_address),
        booking_item(
          service!inner(name),
          collection_date!inner(date)
        )
      `
      )
      .eq('id', ticket.booking_id)
      .single()

    if (booking) {
      const prop = booking.eligible_properties as {
        formatted_address: string | null
      } | null
      const items = booking.booking_item as Array<{
        service: { name: string }
        collection_date: { date: string }
      }>

      linkedBooking = {
        ref: booking.ref,
        address: prop?.formatted_address ?? '',
        collectionDate: items[0]?.collection_date?.date ?? null,
        services: items.map((i) => i.service.name),
      }
    }
  }

  // Build enriched responses with staff names
  const enrichedResponses = (responses ?? []).map((r) => ({
    id: r.id,
    authorType: r.author_type as 'staff' | 'resident',
    authorName:
      r.author_type === 'staff'
        ? (staffNames[r.author_id] ?? 'Support')
        : null,
    message: r.message,
    createdAt: r.created_at,
  }))

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <TicketDetailClient
        ticket={{
          id: ticket.id,
          displayId: ticket.display_id,
          subject: ticket.subject,
          message: ticket.message,
          status: ticket.status,
          category: ticket.category,
          createdAt: ticket.created_at,
        }}
        responses={enrichedResponses}
        linkedBooking={linkedBooking}
      />
    </main>
  )
}
