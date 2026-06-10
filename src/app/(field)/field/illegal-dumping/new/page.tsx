import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { getRangerScope } from '@/lib/field/ranger-scope'
import { IdBookingForm } from './id-booking-form'

interface NewIdBookingPageProps {
  searchParams: Promise<{ lat?: string; lng?: string; address?: string }>
}

export default async function NewIdBookingPage({ searchParams }: NewIdBookingPageProps) {
  const supabase = await createClient()

  // Validate ranger role — field role cannot create ID bookings (PRD §2.2)
  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'ranger') {
    redirect('/field')
  }

  const scope = await getRangerScope(supabase)
  if (!scope) {
    redirect('/field')
  }

  // AWST calendar date — toISOString() is UTC and resolves to *yesterday*
  // between midnight and 8am Perth time.
  const today = awstDateFromUtc(new Date())

  // Fetch ID-eligible collection dates. collection_date is public-SELECT —
  // RLS does NOT tenant-scope it (CLAUDE.md §21), so the ranger's area scope
  // is the filter. Without it a Kwinana ranger would see (and try to book
  // against) Verge Valet dates.
  const { data: dates } = await supabase
    .from('collection_date')
    .select(
      'id, date, id_capacity_limit, id_units_booked, id_is_closed, collection_area!inner(id, code, name)'
    )
    .in('collection_area_id', scope.areaIds)
    .eq('is_open', true)
    .eq('id_is_closed', false)
    .gte('date', today)
    .order('date', { ascending: true })
    .limit(9)

  // Prefill from the lookup tool ("Raise ID at this address") — lat/lng must
  // both parse or the pair is discarded; address may stand alone (manual
  // entry remains mandatory fallback per plan §Risks 7).
  const params = await searchParams
  const lat = Number(params.lat)
  const lng = Number(params.lng)
  const hasCoords =
    params.lat !== undefined &&
    params.lng !== undefined &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  const prefill =
    hasCoords && params.address
      ? { latitude: lat, longitude: lng, address: params.address }
      : null

  return <IdBookingForm collectionDates={dates ?? []} prefill={prefill} />
}
