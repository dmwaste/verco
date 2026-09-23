import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveAuditLogs } from '@/lib/audit/resolve'
import { NcnDetailClient } from './ncn-detail-client'
import { checkRebookDate, bucketsFromRow } from '@/lib/booking/rebook-date-access'

interface NcnDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function NcnDetailPage({ params }: NcnDetailPageProps) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  // contractor_fault not in generated types yet — select without it, then fetch separately
  const { data: ncnBase } = await supabase
    .from('non_conformance_notice')
    .select(
      `id, reason, status, notes, photos, reported_at, resolved_at,
       resolution_notes,
       rescheduled_date,
       booking:booking!non_conformance_notice_booking_id_fkey(
         id, ref, status, type, location,
         property:property_id(formatted_address, address),
         collection_area!inner(id, name, code),
         contact:contact_id(full_name, email, mobile_e164),
         booking_item(id, no_services, is_extra, unit_price_cents, service!inner(name, category(code)))
       ),
       reporter:profiles!non_conformance_notice_reported_by_fkey(display_name),
       resolver:profiles!non_conformance_notice_resolved_by_fkey(display_name),
       rescheduled_booking:booking!non_conformance_notice_rescheduled_booking_id_fkey(id, ref)`
    )
    .eq('id', id)
    .single()

  if (!ncnBase) redirect('/admin/non-conformance')

  // contractor_fault added in migration 20260401110000 — merge manually until types regen
  const ncn = { ...ncnBase, contractor_fault: false } as typeof ncnBase & { contractor_fault: boolean }

  // Fetch available collection dates for rebook dialog (same area, future, open)
  const booking = ncn.booking as unknown as {
    collection_area: { id: string }
  } | null

  let availableDates: { id: string; date: string; insideLockWindow: boolean }[] = []
  if (booking) {
    // Capacity buckets this booking needs. The action re-derives this from the
    // items it actually clones (stream-scoped for a per-stop notice); using
    // every item's category here is the conservative superset — it can hide a
    // date the action would accept, never offer one it will refuse.
    const requiredBuckets = [
      ...new Set(
        ((ncn.booking as unknown as {
          booking_item?: Array<{ service?: { category?: { code: string } | null } | null }>
        } | null)?.booking_item ?? [])
          .map((i) => i.service?.category?.code)
          .filter((c): c is string => Boolean(c)),
      ),
    ]

    const { data } = await supabase
      .from('collection_date')
      .select(
        `id, date, is_open, locked_closed,
         bulk_is_closed, bulk_capacity_limit, bulk_units_booked,
         anc_is_closed, anc_capacity_limit, anc_units_booked,
         id_is_closed, id_capacity_limit, id_units_booked`,
      )
      .eq('collection_area_id', booking.collection_area.id)
      .eq('is_open', true)
      .gt('date', new Date().toISOString().split('T')[0])
      .order('date', { ascending: true })
      .limit(20)

    // Pooled areas keep their real counters on collection_date_pool — their own
    // row reads a limit of 0, so a pooled date must be judged on the pool's row.
    const { data: area } = await supabase
      .from('collection_area')
      .select('capacity_pool_id')
      .eq('id', booking.collection_area.id)
      .single()

    const poolByDate = new Map<string, NonNullable<typeof data>[number]>()
    if (area?.capacity_pool_id && (data ?? []).length > 0) {
      const { data: poolRows } = await supabase
        .from('collection_date_pool')
        .select(
          `date, locked_closed,
           bulk_is_closed, bulk_capacity_limit, bulk_units_booked,
           anc_is_closed, anc_capacity_limit, anc_units_booked,
           id_is_closed, id_capacity_limit, id_units_booked`,
        )
        .eq('capacity_pool_id', area.capacity_pool_id)
        .in('date', (data ?? []).map((d) => d.date))
      for (const row of poolRows ?? []) {
        poolByDate.set(row.date, row as unknown as NonNullable<typeof data>[number])
      }
    }

    availableDates = (data ?? []).flatMap((d) => {
      // A pooled area with no pool row for that date has no capacity to book.
      const gateRow = area?.capacity_pool_id ? poolByDate.get(d.date) : d
      if (!gateRow) return []
      const verdict = checkRebookDate(
        {
          date: d.date,
          is_open: d.is_open,
          locked_closed: gateRow.locked_closed,
          buckets: bucketsFromRow(gateRow),
        },
        requiredBuckets,
      )
      if (!verdict.bookable) return []
      return [{ id: d.id, date: d.date, insideLockWindow: verdict.insideLockWindow }]
    })
  }

  // Fetch resolved audit trail
  const auditLogs = await resolveAuditLogs(supabase, 'non_conformance_notice', id)

  return <NcnDetailClient ncn={ncn} availableDates={availableDates} auditLogs={auditLogs} />
}
