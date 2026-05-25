import { createClient } from '@/lib/supabase/server'
import { RunSheetClient } from './run-sheet-client'

export default async function RunSheetPage() {
  const supabase = await createClient()

  const today = new Date().toISOString().split('T')[0]

  // Fetch today's scheduled bookings — NO PII fields. Structural exclusion.
  // Never select contacts.full_name, contacts.email, contacts.mobile_e164.
  //
  // SQL-side date filter via PostgREST nested `!inner` + dot-path eq: keeps
  // payload bounded to bookings whose at-least-one item has a collection_date
  // on today. Previous JS-filter approach grew unboundedly with historical
  // Scheduled/Completed/NCN/NP records.
  const { data: bookings } = await supabase
    .from('booking')
    .select(
      `id, ref, status, type, location, notes, latitude, longitude, geo_address,
       photos, id_waste_types, id_volume,
       collection_area!inner(name, code),
       eligible_properties:property_id(address, formatted_address, latitude, longitude),
       booking_item!inner(
         id, no_services, is_extra, unit_price_cents, actual_services,
         service!inner(name),
         collection_date!inner(date)
       )`
    )
    .eq('booking_item.collection_date.date', today)
    .in('status', ['Scheduled', 'Completed', 'Non-conformance', 'Nothing Presented'])
    .order('created_at', { ascending: true })

  return <RunSheetClient bookings={bookings ?? []} />
}
