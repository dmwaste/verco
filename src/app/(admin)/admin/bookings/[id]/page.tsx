import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveAuditLogs } from '@/lib/audit/resolve'
import { BookingDetailPanel } from './booking-detail-panel'

interface BookingDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function AdminBookingDetailPage({
  params,
}: BookingDetailPageProps) {
  const { id } = await params
  const supabase = await createClient()

  // RLS ensures scoping. Admin roles can see all bookings within their tenant.
  const { data: booking } = await supabase
    .from('booking')
    .select(
      `id, ref, status, type, location, notes, created_at, updated_at,
       property_id, collection_area_id, contact_id,
       latitude, longitude, geo_address, photos, id_waste_types, id_volume,
       collection_area!inner(name, code),
       eligible_properties:property_id(formatted_address, address),
       contact:contact_id(first_name, last_name, full_name, mobile_e164, email),
       booking_item(
         id, service_id, collection_date_id, no_services, is_extra, unit_price_cents,
         service!inner(name),
         collection_date!inner(date)
       )`
    )
    .eq('id', id)
    .single()

  if (!booking) {
    redirect('/admin/bookings')
  }

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
    <div className="flex h-full">
      {/* Dimmed bookings list placeholder */}
      <div className="flex flex-1 flex-col opacity-45">
        <div className="border-b border-gray-100 bg-white px-7 pb-5 pt-6">
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Bookings
          </h1>
        </div>
        <div className="flex-1 px-7 py-4">
          <div className="rounded-xl bg-white p-8 text-center text-sm text-gray-400 shadow-sm">
            Select a booking to view details
          </div>
        </div>
      </div>

      {/* Detail panel */}
      <BookingDetailPanel
        booking={booking}
        auditLogs={auditLogs}
      />
    </div>
  )
}
