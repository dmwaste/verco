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

  // Prefill from the lookup tool ("Raise ID at this address"). lat/lng must
  // both parse to be used (Number('') is 0 — empty strings are rejected, or
  // an ID would pin to Null Island); an address may stand alone for
  // un-geocoded properties, seeding the field while GPS still acquires.
  // Array-valued params (duplicated keys) are treated as absent.
  const params = await searchParams
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v : null
  const latRaw = str(params.lat)
  const lngRaw = str(params.lng)
  const lat = latRaw !== null ? Number(latRaw) : NaN
  const lng = lngRaw !== null ? Number(lngRaw) : NaN
  const hasCoords =
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  const address = str(params.address)
  const prefill = address
    ? {
        latitude: hasCoords ? lat : null,
        longitude: hasCoords ? lng : null,
        address,
      }
    : null

  return (
    <IdBookingForm
      // Remount on prefill change: the form seeds state in useState
      // initialisers, and a same-path soft navigation (New ID nav tab after
      // a lookup deep link) would otherwise keep the previous property's
      // pinned coordinates (CLAUDE.md §21 searchParams gotcha).
      key={prefill ? `${prefill.latitude},${prefill.longitude},${prefill.address}` : 'gps'}
      collectionDates={dates ?? []}
      prefill={prefill}
    />
  )
}
