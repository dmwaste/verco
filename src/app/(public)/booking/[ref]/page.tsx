import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { BookingDetailClient } from './booking-detail-client'

interface BookingDetailPageProps {
  params: Promise<{ ref: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function BookingDetailPage({
  params,
  searchParams,
}: BookingDetailPageProps) {
  const { ref } = await params
  const resolvedSearchParams = await searchParams
  const paymentSuccess = resolvedSearchParams.success === 'true'
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth')
  }

  // RLS ensures this only returns if the booking belongs to the current user
  const { data: booking } = await supabase
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
      property_id,
      collection_area_id,
      collection_area!inner(name),
      contact:contact_id(full_name, email, mobile_e164),
      property:property_id(formatted_address, address),
      booking_item(
        id,
        service_id,
        collection_date_id,
        no_services,
        is_extra,
        unit_price_cents,
        service!inner(name),
        collection_date!inner(date)
      )
    `
    )
    .eq('ref', ref)
    .single()

  if (!booking) {
    redirect('/dashboard')
  }

  // Fetch service tickets linked to this booking (RLS scopes to resident's own)
  const { data: tickets } = await supabase
    .from('service_ticket')
    .select('id, display_id, subject, status, category, created_at')
    .eq('booking_id', booking.id)
    .order('created_at', { ascending: false })

  // Fetch NCN if booking status is Non-conformance (resident sees reason, photos, status, dispute)
  let ncnData: { id: string; reason: string; status: string; photos: string[]; reported_at: string; rescheduled_booking: { ref: string } | null } | null = null
  if (booking.status === 'Non-conformance' || booking.status === 'Rebooked') {
    const { data: ncn } = await supabase
      .from('non_conformance_notice')
      .select('id, reason, status, photos, reported_at, rescheduled_booking:booking!non_conformance_notice_rescheduled_booking_id_fkey(ref)')
      .eq('booking_id', booking.id)
      .maybeSingle()

    if (ncn) {
      ncnData = ncn as unknown as typeof ncnData
    }
  }

  // Fetch NP if booking status is Nothing Presented
  let npData: { id: string; status: string; photos: string[]; reported_at: string; contractor_fault: boolean; rescheduled_booking: { ref: string } | null } | null = null
  if (booking.status === 'Nothing Presented' || booking.status === 'Rebooked') {
    const { data: npRaw } = await supabase
      .from('nothing_presented')
      .select('id, status, photos, reported_at, contractor_fault, rescheduled_booking:booking!nothing_presented_rescheduled_booking_id_fkey(ref)')
      .eq('booking_id', booking.id)
      .maybeSingle()

    if (npRaw) {
      npData = {
        id: npRaw.id,
        status: npRaw.status,
        photos: npRaw.photos,
        reported_at: npRaw.reported_at,
        contractor_fault: npRaw.contractor_fault,
        rescheduled_booking: npRaw.rescheduled_booking as { ref: string } | null,
      }
    }
  }

  // Fetch receipt URL from paid booking_payment (separate query — receipt_url column
  // added in migration 20260401100000, types will be stale until next regen)
  let receiptUrl: string | null = null
  const { data: payments } = await supabase
    .from('booking_payment')
    .select('receipt_url, status')
    .eq('booking_id', booking.id)
    .eq('status', 'paid')
    .limit(1)

  if (payments && payments.length > 0) {
    // receipt_url added in migration 20260401100000 — cast through unknown until types regen
    const payment = payments[0] as unknown as Record<string, unknown>
    receiptUrl = (typeof payment?.receipt_url === 'string' ? payment.receipt_url : null)
  }

  // Per-client place-out window — different councils have different policies
  // (KWN=48h / 2d, Verge Valet=72h / 3d). Read from the tenant resolved by
  // hostname; default to 48 if missing.
  const headerStore = await headers()
  const tenantClientId = headerStore.get('x-client-id')
  let placeOutHoursBefore = 48
  let serviceName: string | null = null
  if (tenantClientId) {
    const { data: c } = await supabase
      .from('client')
      .select('place_out_hours_before, service_name')
      .eq('id', tenantClientId)
      .single()
    placeOutHoursBefore = c?.place_out_hours_before ?? 48
    serviceName = c?.service_name ?? null
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <BookingDetailClient booking={booking} tickets={tickets ?? []} receiptUrl={receiptUrl} ncn={ncnData} np={npData} paymentSuccess={paymentSuccess} placeOutHoursBefore={placeOutHoursBefore} serviceName={serviceName} />
    </main>
  )
}
