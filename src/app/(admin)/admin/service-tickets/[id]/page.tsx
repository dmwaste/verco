import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveAuditLogs } from '@/lib/audit/resolve'
import { AdminTicketDetailClient } from './admin-ticket-detail-client'

interface AdminTicketDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function AdminTicketDetailPage({
  params,
}: AdminTicketDetailPageProps) {
  const { id: displayId } = await params
  const supabase = await createClient()

  // RLS: staff_select policy scopes to accessible clients
  const { data: ticket } = await supabase
    .from('service_ticket')
    .select(
      `id, display_id, subject, message, status, priority, category, channel,
       booking_id, assigned_to, created_at, updated_at, resolved_at, closed_at,
       contact:contact_id(id, full_name, email, mobile_e164)`
    )
    .eq('display_id', displayId)
    .single()

  if (!ticket) {
    redirect('/admin/service-tickets')
  }

  // Fetch ALL responses including internal notes (staff RLS allows this)
  const { data: responses } = await supabase
    .from('ticket_response')
    .select('id, author_id, author_type, message, is_internal, created_at')
    .eq('ticket_id', ticket.id)
    .order('created_at', { ascending: true })

  // Fetch author names for all responses
  const authorIds = [...new Set((responses ?? []).map((r) => r.author_id))]
  let authorNames: Record<string, string> = {}
  if (authorIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', authorIds)

    if (profiles) {
      authorNames = Object.fromEntries(
        profiles.map((p) => [p.id, p.display_name ?? 'Unknown'])
      )
    }
  }

  // Fetch staff users for "assign to" dropdown
  // Use service_ticket.client_id to scope — we need to get it from the ticket
  const { data: ticketWithClient } = await supabase
    .from('service_ticket')
    .select('client_id')
    .eq('id', ticket.id)
    .single()

  const staffUsers: { id: string; name: string }[] = []
  if (ticketWithClient) {
    const { data: staffRoles } = await supabase
      .from('user_roles')
      .select('user_id, profiles!inner(id, display_name)')
      .in('role', ['client-admin', 'client-staff', 'contractor-admin', 'contractor-staff'])
      .eq('is_active', true)

    if (staffRoles) {
      const seen = new Set<string>()
      for (const r of staffRoles) {
        const profile = r.profiles as unknown as { id: string; display_name: string | null }
        if (!seen.has(profile.id)) {
          seen.add(profile.id)
          staffUsers.push({
            id: profile.id,
            name: profile.display_name ?? profile.id.slice(0, 8),
          })
        }
      }
    }
  }

  // Fetch linked booking if present
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
        `ref,
         eligible_properties:property_id(formatted_address),
         booking_item(service!inner(name), collection_date!inner(date))`
      )
      .eq('id', ticket.booking_id)
      .single()

    if (booking) {
      const prop = booking.eligible_properties as { formatted_address: string | null } | null
      const items = booking.booking_item as Array<{ service: { name: string }; collection_date: { date: string } }>
      linkedBooking = {
        ref: booking.ref,
        address: prop?.formatted_address ?? '',
        collectionDate: items[0]?.collection_date?.date ?? null,
        services: items.map((i) => i.service.name),
      }
    }
  }

  // Fetch resolved audit trail (ticket + responses)
  const auditLogs = await resolveAuditLogs(supabase, 'service_ticket', ticket.id, {
    includeChildren: [
      { table: 'ticket_response', fkColumn: 'ticket_id' },
    ],
  })

  const contact = ticket.contact as { id: string; full_name: string; email: string; mobile_e164: string | null } | null

  const enrichedResponses = (responses ?? []).map((r) => ({
    id: r.id,
    authorType: r.author_type as 'staff' | 'resident',
    authorName: authorNames[r.author_id] ?? 'Unknown',
    message: r.message,
    isInternal: r.is_internal,
    createdAt: r.created_at,
  }))

  return (
    <div className="p-6">
      <AdminTicketDetailClient
        ticket={{
          id: ticket.id,
          displayId: ticket.display_id,
          subject: ticket.subject,
          message: ticket.message,
          status: ticket.status,
          priority: ticket.priority,
          category: ticket.category,
          channel: ticket.channel,
          assignedTo: ticket.assigned_to,
          createdAt: ticket.created_at,
          updatedAt: ticket.updated_at,
          resolvedAt: ticket.resolved_at,
          closedAt: ticket.closed_at,
        }}
        contact={contact}
        responses={enrichedResponses}
        staffUsers={staffUsers}
        linkedBooking={linkedBooking}
        auditLogs={auditLogs}
      />
    </div>
  )
}
