import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { BookingCloseoutClient } from './booking-closeout-client'

interface BookingCloseoutPageProps {
  params: Promise<{ ref: string }>
}

export default async function BookingCloseoutPage({
  params,
}: BookingCloseoutPageProps) {
  const { ref } = await params
  const supabase = await createClient()

  // Structural PII exclusion — never select contact fields for field roles
  const { data: booking } = await supabase
    .from('booking')
    .select(
      `id, ref, status, type, location, notes, latitude, longitude, geo_address,
       photos, id_waste_types, id_volume,
       collection_area!inner(name, code),
       eligible_properties:property_id(address, formatted_address, latitude, longitude),
       booking_item(
         id, no_services, is_extra, unit_price_cents, actual_services,
         service!inner(name),
         collection_date!inner(date)
       ),
       collection_stop(id, stream, status, stop_sequence)`
    )
    .eq('ref', ref)
    .single()

  if (!booking) {
    redirect('/field/run-sheet')
  }

  return <BookingCloseoutClient booking={booking} />
}
