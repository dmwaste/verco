import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveAuditLogs } from '@/lib/audit/resolve'
import { BookingDetailClient } from './booking-detail-client'
import { buildMudContext } from './mud-context'
import { isContractorStaff } from '@/lib/auth/roles'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import type { CloseoutCorrection, CloseoutStop } from './closeout-card'
import { summariseNotes } from '@/lib/property-notes/validation'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * Closeout outcomes per collection pass + the office corrections made to them
 * (ADR 0030). Contractor tier only: stop_outcome_correction RLS is
 * contractor-only, and councils see the outcome via the booking status and
 * the exceptions card.
 */
async function loadCloseout(supabase: SupabaseServerClient, bookingId: string) {
  const [{ data: stops }, { data: corrections }] = await Promise.all([
    supabase
      .from('collection_stop')
      .select('id, stream, status, collection_date:collection_date_id(date)')
      .eq('booking_id', bookingId)
      .order('stream'),
    supabase
      .from('stop_outcome_correction')
      .select('id, collection_stop_id, from_status, to_status, reason, corrected_by, corrected_at')
      .eq('booking_id', bookingId)
      .order('corrected_at', { ascending: false }),
  ])

  // Staff names via the DEFINER resolver — a direct profiles embed is
  // RLS-hidden for other staff (renders as blank/"System").
  const actorIds = [...new Set((corrections ?? []).map((c) => c.corrected_by))]
  const { data: names } =
    actorIds.length > 0
      ? await supabase.rpc('resolve_actor_names', { p_user_ids: actorIds })
      : { data: [] }
  const nameById = new Map((names ?? []).map((n) => [n.user_id, n.name]))

  return {
    todayAwst: awstDateFromUtc(new Date()),
    stops: (stops ?? []).flatMap((s): CloseoutStop[] => {
      const date = (s.collection_date as { date: string } | null)?.date
      return date ? [{ id: s.id, stream: s.stream, status: s.status, collectionDate: date }] : []
    }),
    corrections: (corrections ?? []).map(
      (c): CloseoutCorrection => ({
        id: c.id,
        stopId: c.collection_stop_id,
        fromStatus: c.from_status,
        toStatus: c.to_status,
        reason: c.reason,
        correctedAt: c.corrected_at,
        correctedByName: nameById.get(c.corrected_by) ?? 'D&M staff',
      }),
    ),
  }
}

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
       property_id, collection_area_id, contact_id, client_id,
       latitude, longitude, geo_address, photos, id_waste_types, id_volume,
       collection_area!inner(name, code),
       eligible_properties:property_id(formatted_address, address, latitude, longitude),
       contact:contact_id(first_name, last_name, full_name, mobile_e164, email),
       booking_item(
         id, service_id, collection_date_id, no_services, actual_services, is_extra, unit_price_cents, updated_at,
         service!inner(name, category!inner(code)),
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
  const [ncnRecords, npRecords, bookingTickets, closeout, propertyNotes] = await Promise.all([
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
    isContractorStaff(userRole) ? loadCloseout(supabase, id) : Promise.resolve(null),
    // Property notes / permission-to-enter forms on file (ADR 0031) — staff +
    // tenant scoped by property_note RLS; only the kinds, for the banner.
    booking.property_id
      ? supabase
          .from('property_note')
          .select('kind')
          .eq('property_id', booking.property_id)
          .is('removed_at', null)
      : Promise.resolve({ data: [] as { kind: string }[], error: null }),
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
      { table: 'stop_outcome_correction', fkColumn: 'booking_id' },
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
      closeout={closeout}
      propertyNotesSummary={
        propertyNotes.error
          ? 'Property notes couldn’t be checked'
          : summariseNotes((propertyNotes.data ?? []).map((n) => n.kind))
      }
    />
  )
}
