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
    />
  )
}
