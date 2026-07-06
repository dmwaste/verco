import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveAuditLogs } from '@/lib/audit/resolve'
import { BookingDetailClient } from './booking-detail-client'
import { buildMudContext } from './mud-context'

interface BookingDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function AdminBookingDetailPage({
  params,
}: BookingDetailPageProps) {
  const { id } = await params
  const supabase = await createClient()

  // Caller role gates the "reschedule a Scheduled booking" affordance —
  // contractor roles only (VER-285). RLS + the server action re-check this.
  const { data: userRole } = await supabase.rpc('current_user_role')

  // RLS ensures scoping. Admin roles can see all bookings within their tenant.
  const { data: booking } = await supabase
    .from('booking')
    .select(
      `id, ref, status, type, location, notes, created_at, updated_at, fy_id,
       property_id, collection_area_id, contact_id,
       latitude, longitude, geo_address, photos, id_waste_types, id_volume,
       collection_area!inner(name, code),
       eligible_properties:property_id(formatted_address, address),
       contact:contact_id(first_name, last_name, full_name, mobile_e164, email),
       booking_item(
         id, service_id, collection_date_id, no_services, actual_services, is_extra, unit_price_cents,
         service!inner(name),
         collection_date!inner(date)
       )`
    )
    .eq('id', id)
    .single()

  if (!booking) {
    redirect('/admin/bookings')
  }

  // MUD context — unit_count, mud_code, strata contact, per-service allowance.
  // Only fetched for MUD bookings; null otherwise.
  const mudContext =
    booking.type === 'MUD' && booking.property_id && booking.collection_area_id
      ? await buildMudContext(supabase, {
          propertyId: booking.property_id,
          collectionAreaId: booking.collection_area_id,
          fyId: booking.fy_id,
        })
      : null

  // Exception records + linked service tickets for the detail cards. A booking
  // can carry several notice records (one per stream, even both NCN & NP), so
  // fetch all — not maybeSingle.
  const [ncnRecords, npRecords, bookingTickets] = await Promise.all([
    supabase
      .from('non_conformance_notice')
      .select('id, reason, status, photos, reported_at, collection_stop:collection_stop_id(stream)')
      .eq('booking_id', id)
      .order('reported_at', { ascending: false }),
    supabase
      .from('nothing_presented')
      .select('id, status, photos, reported_at, contractor_fault, collection_stop:collection_stop_id(stream)')
      .eq('booking_id', id)
      .order('reported_at', { ascending: false }),
    supabase
      .from('service_ticket')
      .select('id, display_id, subject, status, category, created_at')
      .eq('booking_id', id)
      .order('created_at', { ascending: false }),
  ])

  const exceptions = [
    ...((ncnRecords.data ?? []).map((r) => ({
      id: r.id,
      kind: 'ncn' as const,
      status: r.status as string,
      reason: r.reason as string | null,
      stream: (r.collection_stop as unknown as { stream: string } | null)?.stream ?? null,
      photos: r.photos,
      reported_at: r.reported_at,
    }))),
    ...((npRecords.data ?? []).map((r) => ({
      id: r.id,
      kind: 'np' as const,
      status: r.status as string,
      reason: null,
      stream: (r.collection_stop as unknown as { stream: string } | null)?.stream ?? null,
      photos: r.photos,
      reported_at: r.reported_at,
      contractor_fault: r.contractor_fault,
    }))),
  ].sort((a, b) => (a.reported_at < b.reported_at ? 1 : -1))

  // Fetch resolved audit trail (booking + child records)
  const auditLogs = await resolveAuditLogs(supabase, 'booking', id, {
    includeChildren: [
      { table: 'booking_item', fkColumn: 'booking_id' },
      ...(booking.contact_id
        ? [{ table: 'contacts', fkColumn: 'id', fkValue: booking.contact_id }]
        : []),
    ],
  })

  return (
    <BookingDetailClient
      booking={booking}
      auditLogs={auditLogs}
      mudContext={mudContext}
      userRole={userRole}
      exceptions={exceptions}
      tickets={bookingTickets.data ?? []}
    />
  )
}
