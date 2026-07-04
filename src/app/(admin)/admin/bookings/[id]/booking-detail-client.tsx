'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Dialog } from '@base-ui/react/dialog'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { invokeEfWithUserToken } from '@/lib/supabase/invoke-ef-client'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import { DetailHeader } from '@/components/admin/detail-header'
import { FieldLabel, Input, Select, Textarea } from '@/components/admin/form'
import { LOCATION_OPTIONS, type LocationOption } from '@/lib/booking/schemas'
import { canEditCollectionDetails } from '@/lib/booking/collection-details-edit'
import { confirmBooking, cancelBooking, updateContact, updateCollectionDetails, updateNotes } from './actions'
import { effectiveCapacity, indexPoolDates } from '@/lib/capacity/effective-capacity'
import { cn } from '@/lib/utils'
import type { Database } from '@/lib/supabase/types'
import type { ResolvedAuditEntry } from '@/lib/audit/resolve'
import { AuditTimeline } from '@/components/audit-timeline'
import type { MudContext } from './mud-context'

type BookingStatus = Database['public']['Enums']['booking_status']
type AppRole = Database['public']['Enums']['app_role']

interface BookingItem {
  id: string
  service_id: string
  collection_date_id: string
  no_services: number
  actual_services: number | null
  is_extra: boolean
  unit_price_cents: number
  service: { name: string }
  collection_date: { date: string }
}

interface Booking {
  id: string
  ref: string
  status: BookingStatus
  type: string
  location: string | null
  notes: string | null
  created_at: string
  updated_at: string
  property_id: string | null
  collection_area_id: string | null
  contact_id: string | null
  latitude: number | null
  longitude: number | null
  geo_address: string | null
  photos: string[]
  id_waste_types: string[]
  id_volume: string | null
  collection_area: { name: string; code: string }
  eligible_properties: { formatted_address: string | null; address: string } | null
  contact: { first_name: string; last_name: string; full_name: string; mobile_e164: string | null; email: string } | null
  booking_item: BookingItem[]
}

interface BookingDetailClientProps {
  booking: Booking
  auditLogs: ResolvedAuditEntry[]
  mudContext?: MudContext | null
  userRole: AppRole | null
}

// Pencil icon shared across edit buttons
function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}

export function BookingDetailClient({
  booking,
  auditLogs,
  mudContext,
  userRole,
}: BookingDetailClientProps) {
  const router = useRouter()
  const listSearchParams = useSearchParams()
  // ?from= carries the list's serialised filter state (set by the Ref link in
  // bookings-list-client) so going back restores the user's search/filter view.
  // Appended after `?` on a fixed path, so it can't change route or origin.
  const fromQuery = listSearchParams.get('from')
  const backHref = fromQuery ? `/admin/bookings?${fromQuery}` : '/admin/bookings'
  const supabase = createClient()
  const [isPending, setIsPending] = useState(false)
  const [isPaying, setIsPaying] = useState(false)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Inline edit states
  const [editingContact, setEditingContact] = useState(false)
  const [editingDetails, setEditingDetails] = useState(false)

  // Contact edit form
  const [editFirstName, setEditFirstName] = useState(booking.contact?.first_name ?? '')
  const [editLastName, setEditLastName] = useState(booking.contact?.last_name ?? '')
  const [editEmail, setEditEmail] = useState(booking.contact?.email ?? '')
  const [editMobile, setEditMobile] = useState(booking.contact?.mobile_e164 ?? '')

  // Details edit form
  const [editLocation, setEditLocation] = useState<LocationOption>(
    (booking.location as LocationOption) ?? 'Front Verge'
  )
  const [editDateId, setEditDateId] = useState(booking.booking_item[0]?.collection_date_id ?? '')

  // Notes edit form
  const [editNotesText, setEditNotesText] = useState(booking.notes ?? '')

  const area = booking.collection_area as { name: string; code: string }
  const property = booking.eligible_properties as { formatted_address: string | null; address: string } | null
  const contact = booking.contact as { first_name: string; last_name: string; full_name: string; mobile_e164: string | null; email: string } | null
  const isId = booking.type === 'Illegal Dumping'
  const isMud = booking.type === 'MUD' && mudContext !== null && mudContext !== undefined
  // ID bookings have no property — use the GPS-resolved address.
  const address = property?.formatted_address ?? property?.address ?? booking.geo_address ?? '—'
  const idMapsUrl =
    booking.latitude != null && booking.longitude != null
      ? `https://maps.google.com/?q=${booking.latitude},${booking.longitude}`
      : null

  const collectionDateStr =
    booking.booking_item.length > 0
      ? (booking.booking_item[0]?.collection_date as { date: string })?.date ?? null
      : null

  const includedItems = booking.booking_item.filter((i) => !i.is_extra)
  const extraItems = booking.booking_item.filter((i) => i.is_extra)
  const totalChargeCents = extraItems.reduce(
    (sum, i) => sum + i.unit_price_cents * i.no_services,
    0
  )

  const canConfirm = booking.status === 'Submitted'
  const canCancel = ['Pending Payment', 'Submitted', 'Confirmed'].includes(booking.status)
  const canEdit = ['Pending Payment', 'Submitted', 'Confirmed'].includes(booking.status)

  // Collection-details edit affordance. Pre-dispatch this matches `canEdit`;
  // once Scheduled it additionally opens to contractor roles so D&M staff can
  // correct a dispatched booking's collection date (VER-285). The
  // updateCollectionDetails server action + RLS re-enforce this.
  const canEditDetails = canEditCollectionDetails(booking.status, userRole)

  // Services edit URL — wizard handles pricing/capacity.
  //
  // MUD bookings are excluded here: the public wizard flow is shaped for
  // SUDs (paid extras, per-unit booking, address-form redirect on is_mud).
  // Editing services on a MUD booking would either (a) miss the MUD
  // allowance re-check (double-spend risk against the per-FY cap) or
  // (b) need a dedicated MUD edit flow — out of scope here. For now,
  // admins cancel and rebook from /admin/properties/[id] (see the
  // "Edit services not supported for MUD" hint below).
  const editServicesUrl = canEdit && !isMud && booking.property_id && booking.collection_area_id
    ? `/book/services?${new URLSearchParams({
        property_id: booking.property_id,
        collection_area_id: booking.collection_area_id,
        address,
        on_behalf: 'true',
        items: booking.booking_item
          .filter((i) => i.no_services > 0)
          .map((i) => `${i.service_id}:${i.no_services}`)
          .join(','),
        total_cents: totalChargeCents.toString(),
        ...(booking.booking_item[0]?.collection_date_id ? { collection_date_id: booking.booking_item[0].collection_date_id } : {}),
        ...(booking.location ? { location: booking.location } : {}),
        ...(booking.notes ? { notes: booking.notes } : {}),
        ...(contact?.first_name ? { contact_first_name: contact.first_name } : {}),
        ...(contact?.last_name ? { contact_last_name: contact.last_name } : {}),
        ...(contact?.email ? { contact_email: contact.email } : {}),
        ...(contact?.mobile_e164 ? { contact_mobile: contact.mobile_e164 } : {}),
        return_url: `/admin/bookings/${booking.id}`,
        // Signals the wizard that submission should cancel this booking
        // (the one being edited) after creating the new one — otherwise the
        // edit flow leaves two bookings at the same address.
        replaces: booking.id,
      }).toString()}`
    : null

  // Fetch the area's pool membership — pool-member areas keep per-date
  // counters at 0 by design; real capacity lives in collection_date_pool.
  const { data: areaPoolMembership } = useQuery({
    queryKey: ['area-pool', booking.collection_area_id],
    enabled: editingDetails && !!booking.collection_area_id,
    queryFn: async () => {
      const { data } = await supabase
        .from('collection_area')
        .select('id, capacity_pool_id')
        .eq('id', booking.collection_area_id!)
        .single()
      return data
    },
  })
  const poolId = areaPoolMembership?.capacity_pool_id ?? null

  // Fetch available collection dates for inline date picker
  const { data: availableDates } = useQuery({
    queryKey: ['collection-dates-admin', booking.collection_area_id],
    enabled: editingDetails && !!booking.collection_area_id,
    queryFn: async () => {
      const { data } = await supabase
        .from('collection_date')
        .select(
          `id, date,
           bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
           anc_capacity_limit, anc_units_booked, anc_is_closed,
           id_capacity_limit, id_units_booked, id_is_closed`,
        )
        .eq('collection_area_id', booking.collection_area_id!)
        .eq('is_open', true)
        .gte('date', new Date().toISOString().split('T')[0])
        .order('date', { ascending: true })
      return data ?? []
    },
  })

  const { data: poolDates } = useQuery({
    queryKey: ['pool-dates-admin', poolId],
    enabled: editingDetails && !!poolId,
    queryFn: async () => {
      if (!poolId) return []
      const { data } = await supabase
        .from('collection_date_pool')
        .select(
          `date,
           bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
           anc_capacity_limit, anc_units_booked, anc_is_closed,
           id_capacity_limit, id_units_booked, id_is_closed`,
        )
        .eq('capacity_pool_id', poolId)
        .gte('date', new Date().toISOString().split('T')[0])
      return data ?? []
    },
  })

  const poolByDate = indexPoolDates(poolDates ?? [])

  async function handleConfirm() {
    setIsPending(true)
    setError(null)
    const result = await confirmBooking(booking.id)
    if (!result.ok) {
      setError(result.error)
      setIsPending(false)
      return
    }
    router.refresh()
  }

  async function handleCancel() {
    setShowCancelDialog(false)
    setIsPending(true)
    setError(null)
    const result = await cancelBooking(booking.id)
    if (!result.ok) {
      setError(result.error)
      setIsPending(false)
      return
    }
    router.refresh()
  }

  async function handlePayNow() {
    setIsPaying(true)
    setError(null)
    try {
      const origin = window.location.origin
      const efResult = await invokeEfWithUserToken<{ checkout_url?: string; already_paid?: boolean }>(
        supabase,
        'create-checkout',
        {
          booking_id: booking.id,
          success_url: `${origin}/admin/bookings/${booking.id}`,
          cancel_url: `${origin}/admin/bookings/${booking.id}`,
        }
      )

      if (!efResult.ok) {
        setError(`Failed to create payment session: ${efResult.error}`)
        setIsPaying(false)
        return
      }
      // Already paid (webhook gap) — booking was just reconciled to Confirmed.
      if (efResult.data.already_paid) {
        window.location.href = `${origin}/admin/bookings/${booking.id}`
        return
      }
      if (!efResult.data.checkout_url) {
        setError('No checkout URL returned. Please try again.')
        setIsPaying(false)
        return
      }

      window.location.href = efResult.data.checkout_url
    } catch {
      setError('An unexpected error occurred')
      setIsPaying(false)
    }
  }

  async function handleSaveContact() {
    if (!booking.contact_id) return
    setIsPending(true)
    setError(null)
    const result = await updateContact(booking.contact_id, {
      first_name: editFirstName,
      last_name: editLastName,
      email: editEmail,
      mobile_e164: editMobile || null,
    })
    if (!result.ok) {
      setError(result.error)
      setIsPending(false)
      return
    }
    setEditingContact(false)
    setIsPending(false)
    router.refresh()
  }

  async function handleSaveDetails() {
    setIsPending(true)
    setError(null)

    // Save notes alongside collection details
    const notesResult = await updateNotes(booking.id, editNotesText)
    if (!notesResult.ok) {
      setError(notesResult.error)
      setIsPending(false)
      return
    }

    const result = await updateCollectionDetails(booking.id, {
      location: editLocation,
      collection_date_id: editDateId || null,
    })
    if (!result.ok) {
      setError(result.error)
      setIsPending(false)
      return
    }
    setEditingDetails(false)
    setIsPending(false)
    router.refresh()
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <DetailHeader
        backHref={backHref}
        backLabel="Bookings"
        title={booking.ref}
        subtitle={<>{booking.type} &middot; {area.name}</>}
      >
        <BookingStatusBadge status={booking.status} />
        {(canConfirm || canCancel || booking.status === 'Pending Payment') && (
          <div className="flex flex-wrap items-center gap-2">
            {booking.status === 'Pending Payment' && (
              <button
                type="button"
                onClick={handlePayNow}
                disabled={isPaying}
                className="flex items-center gap-1.5 rounded-lg border-[1.5px] border-[#00B864] bg-[#E8FDF0] px-4 py-2 text-body-sm font-semibold text-[#006A38] disabled:opacity-50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                  <line x1="1" y1="10" x2="23" y2="10" />
                </svg>
                {isPaying ? 'Redirecting to payment...' : 'Pay Now'}
              </button>
            )}
            {canConfirm && (
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isPending}
                className="flex items-center gap-1.5 rounded-lg bg-[#00E47C] px-4 py-2 text-body-sm font-semibold text-[#293F52] disabled:opacity-50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                {isPending ? 'Confirming...' : 'Confirm Booking'}
              </button>
            )}
            {canCancel && (
              <button
                type="button"
                onClick={() => setShowCancelDialog(true)}
                disabled={isPending}
                className="flex items-center gap-1.5 rounded-lg border-[1.5px] border-[#E53E3E] bg-[#FFF0F0] px-4 py-2 text-body-sm font-semibold text-[#E53E3E] disabled:opacity-50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                {isPending ? 'Cancelling...' : 'Cancel Booking'}
              </button>
            )}
          </div>
        )}
      </DetailHeader>

      {/* Content */}
      <div className="flex-1 px-7 py-5">
      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">

      {/* MUD Context — only for MUD bookings */}
      {mudContext && (
        <div className="rounded-xl bg-[#FAF8FF] p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-caption font-semibold uppercase tracking-wide text-[#805AD5]">
              MUD Context
            </span>
            <Link
              href={`/admin/properties/${mudContext.propertyId}`}
              className="text-xs font-medium text-[#805AD5] hover:underline"
            >
              View property &rarr;
            </Link>
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="flex gap-3">
              <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">MUD code</span>
              <span className="min-w-0 flex-1 break-words text-body-sm text-gray-900">
                {mudContext.mudCode ?? '—'}
              </span>
            </div>
            <div className="flex gap-3">
              <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Unit count</span>
              <span className="min-w-0 flex-1 break-words text-body-sm text-gray-900">{mudContext.unitCount}</span>
            </div>
            <div className="flex gap-3">
              <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Onboarding</span>
              <span className="min-w-0 flex-1 break-words text-body-sm text-gray-900">
                {mudContext.onboardingStatus ?? '—'}
              </span>
            </div>

            {mudContext.strataContact && (
              <div className="mt-1 border-t border-gray-100 pt-2.5">
                <div className="mb-1.5 text-caption font-semibold uppercase tracking-wide text-gray-500">
                  Strata contact
                </div>
                <div className="text-body-sm text-gray-900">{mudContext.strataContact.fullName}</div>
                {mudContext.strataContact.email && (
                  <div className="text-xs text-gray-600">{mudContext.strataContact.email}</div>
                )}
                {mudContext.strataContact.mobile && (
                  <div className="text-xs text-gray-600">{mudContext.strataContact.mobile}</div>
                )}
              </div>
            )}

            {mudContext.allowance.length > 0 && (
              <div className="mt-1 border-t border-gray-100 pt-2.5">
                <div className="mb-1.5 text-caption font-semibold uppercase tracking-wide text-gray-500">
                  FY allowance
                </div>
                <div className="flex flex-col gap-1.5">
                  {mudContext.allowance.map((row) => {
                    const remaining = row.total_cap - row.used
                    const exhausted = remaining <= 0
                    return (
                      <div key={row.service_id} className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-xs text-gray-700">{row.service_name}</span>
                        <span
                          className={cn(
                            'shrink-0 text-xs font-medium tabular-nums',
                            exhausted ? 'text-red-600' : 'text-gray-900'
                          )}
                        >
                          {row.used}/{row.total_cap}
                          {row.override_extras > 0 && (
                            <span className="ml-1 text-2xs text-gray-500">
                              (+{row.override_extras})
                            </span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Property + Collection Details */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-caption font-semibold uppercase tracking-wide text-gray-500">
            Collection Details
          </span>
          {canEditDetails && !editingDetails && (
            <button type="button" onClick={() => setEditingDetails(true)} className="text-gray-400 hover:text-[#293F52]" aria-label="Edit collection details">
              <PencilIcon />
            </button>
          )}
        </div>

        {!editingDetails ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex gap-3">
              <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Address</span>
              <span className="min-w-0 flex-1 break-words text-body-sm text-gray-900">{address}</span>
            </div>
            <div className="flex gap-3">
              <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Location</span>
              <span className="min-w-0 flex-1 break-words text-body-sm text-gray-900">{booking.location ?? '—'}</span>
            </div>
            <div className="flex gap-3">
              <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Collection Date</span>
              <span className="min-w-0 flex-1 break-words text-body-sm text-gray-900">
                {collectionDateStr
                  ? format(new Date(collectionDateStr + 'T00:00:00'), 'EEEE, d MMMM yyyy')
                  : '—'}
              </span>
            </div>
            <div className="flex gap-3">
              <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Notes</span>
              <span className="min-w-0 flex-1 break-words text-body-sm italic text-gray-500">{booking.notes || '—'}</span>
            </div>
            {isId && idMapsUrl && (
              <div className="flex gap-3">
                <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Map</span>
                <a
                  href={idMapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-body-sm font-medium text-[#293F52] underline"
                >
                  Open in Google Maps
                </a>
              </div>
            )}
            {isId && (booking.id_waste_types.length > 0 || booking.id_volume) && (
              <div className="flex gap-3">
                <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Waste</span>
                <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                  {booking.id_waste_types.map((w) => (
                    <span
                      key={w}
                      className="inline-flex rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-caption font-medium text-[#293F52]"
                    >
                      {w}
                    </span>
                  ))}
                  {booking.id_volume && (
                    <span className="inline-flex rounded-full bg-[#FFF3EA] px-2.5 py-0.5 text-caption font-medium text-[#8B4000]">
                      {booking.id_volume}
                    </span>
                  )}
                </div>
              </div>
            )}
            {isId && booking.photos.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-gray-500">Evidence Photos</span>
                <div className="flex flex-wrap gap-2">
                  {booking.photos.map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt={`Evidence ${i + 1}`}
                        className="size-20 rounded-lg object-cover"
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Location</label>
              <div className="flex flex-wrap gap-1.5">
                {LOCATION_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setEditLocation(opt)}
                    className={cn(
                      'rounded-full border-[1.5px] px-3 py-1.5 text-caption font-medium transition-colors',
                      editLocation === opt
                        ? 'border-[#293F52] bg-[#293F52] text-white'
                        : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                    )}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <FieldLabel htmlFor="bd-date">Collection Date</FieldLabel>
              <Select
                id="bd-date"
                value={editDateId}
                onChange={(e) => setEditDateId(e.target.value)}
                className="py-2"
              >
                <option value="">Select date...</option>
                {(availableDates ?? []).map((d) => {
                  const cap = effectiveCapacity(d, poolId, poolByDate)
                  const spots = Math.max(0, cap.bulk_capacity_limit - cap.bulk_units_booked)
                  return (
                    <option key={d.id} value={d.id}>
                      {format(new Date(d.date + 'T00:00:00'), 'EEE d MMM yyyy')} ({spots} spots)
                    </option>
                  )
                })}
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor="bd-notes">Notes</FieldLabel>
              <Textarea
                id="bd-notes"
                value={editNotesText}
                onChange={(e) => setEditNotesText(e.target.value)}
                maxLength={500}
                placeholder="Notes for driver..."
                className="h-16 resize-none py-2"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSaveDetails}
                disabled={isPending}
                className="flex-1 rounded-lg bg-[#293F52] px-3 py-2 text-body-sm font-semibold text-white disabled:opacity-50"
              >
                {isPending ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingDetails(false)
                  setEditLocation((booking.location as LocationOption) ?? 'Front Verge')
                  setEditDateId(booking.booking_item[0]?.collection_date_id ?? '')
                  setEditNotesText(booking.notes ?? '')
                }}
                className="flex-1 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-2 text-body-sm font-semibold text-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Contact — visible to admin/staff only, enforced by RLS */}
      {(contact || canEdit) && (
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-caption font-semibold uppercase tracking-wide text-gray-500">
              Contact
            </span>
            {canEdit && !editingContact && contact && (
              <button type="button" onClick={() => setEditingContact(true)} className="text-gray-400 hover:text-[#293F52]" aria-label="Edit contact">
                <PencilIcon />
              </button>
            )}
          </div>

          {!editingContact ? (
            contact ? (
              <div className="flex flex-col gap-2.5">
                <div className="flex gap-3">
                  <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Name</span>
                  <span className="min-w-0 flex-1 break-words text-body-sm font-medium text-[#293F52]">{contact.full_name}</span>
                </div>
                <div className="flex gap-3">
                  <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Mobile</span>
                  <span className="min-w-0 flex-1 break-words text-body-sm font-medium text-[#293F52]">{contact.mobile_e164 ?? '—'}</span>
                </div>
                <div className="flex gap-3">
                  <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Email</span>
                  <span className="min-w-0 flex-1 break-words text-body-sm font-medium text-[#293F52]">{contact.email}</span>
                </div>
              </div>
            ) : (
              <p className="text-body-sm italic text-gray-400">No contact linked</p>
            )
          ) : (
            <div className="flex flex-col gap-2.5">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <FieldLabel htmlFor="bd-first-name">First name</FieldLabel>
                  <Input
                    id="bd-first-name"
                    type="text"
                    autoComplete="given-name"
                    value={editFirstName}
                    onChange={(e) => setEditFirstName(e.target.value)}
                    className="py-2"
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="bd-last-name">Last name</FieldLabel>
                  <Input
                    id="bd-last-name"
                    type="text"
                    autoComplete="family-name"
                    value={editLastName}
                    onChange={(e) => setEditLastName(e.target.value)}
                    className="py-2"
                  />
                </div>
              </div>
              <div>
                <FieldLabel htmlFor="bd-email">Email</FieldLabel>
                <Input
                  id="bd-email"
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  className="py-2"
                />
              </div>
              <div>
                <FieldLabel htmlFor="bd-mobile">Mobile</FieldLabel>
                <Input
                  id="bd-mobile"
                  type="tel"
                  value={editMobile}
                  onChange={(e) => setEditMobile(e.target.value)}
                  placeholder="+614XXXXXXXX"
                  className="py-2"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveContact}
                  disabled={isPending || !editFirstName || !editLastName || !editEmail}
                  className="flex-1 rounded-lg bg-[#293F52] px-3 py-2 text-body-sm font-semibold text-white disabled:opacity-50"
                >
                  {isPending ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingContact(false)
                    setEditFirstName(contact?.first_name ?? '')
                    setEditLastName(contact?.last_name ?? '')
                    setEditEmail(contact?.email ?? '')
                    setEditMobile(contact?.mobile_e164 ?? '')
                  }}
                  className="flex-1 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-2 text-body-sm font-semibold text-gray-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Services — edit via wizard (pricing/capacity) */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-caption font-semibold uppercase tracking-wide text-gray-500">
            Services
          </span>
          {editServicesUrl && (
            <Link href={editServicesUrl} className="text-gray-400 hover:text-[#293F52]" aria-label="Edit services">
              <PencilIcon />
            </Link>
          )}
          {isMud && canEdit && (
            <span
              className="text-2xs text-gray-500"
              title="Edit services not supported for MUD bookings. Cancel this booking and rebook from the property page."
            >
              Cancel &amp; rebook to edit
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          {includedItems.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-lg bg-[#E8FDF0] px-2.5 py-2 text-body-sm"
            >
              <span className="text-gray-900">
                {(item.service as { name: string }).name} &times; {item.no_services}
              </span>
              {isMud && item.actual_services != null ? (
                <span className="font-medium text-[#006A38]" title="Units actually serviced at closeout">
                  {item.actual_services} collected
                </span>
              ) : (
                <span className="font-medium text-[#006A38]">Included</span>
              )}
            </div>
          ))}
          {extraItems.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-lg bg-[#E8EEF2] px-2.5 py-2 text-body-sm"
            >
              <span className="text-gray-900">
                {(item.service as { name: string }).name} &times; {item.no_services} (extra)
              </span>
              <span className="font-semibold text-[#293F52]">
                ${((item.unit_price_cents * item.no_services) / 100).toFixed(2)}
              </span>
            </div>
          ))}
          {totalChargeCents > 0 && (
            <div className="flex items-center justify-between rounded-lg bg-[#293F52] px-2.5 py-2.5 text-body-sm">
              <span className="font-semibold text-white">Total charged</span>
              <span className="font-[family-name:var(--font-heading)] text-body font-bold text-[#00E47C]">
                ${(totalChargeCents / 100).toFixed(2)}
              </span>
            </div>
          )}
        </div>
      </div>

      </div>

      {/* Activity — right column */}
      <div className="flex min-w-0 flex-col gap-4">
        {auditLogs.length > 0 && (
          <div className="rounded-xl bg-white shadow-sm">
            <AuditTimeline entries={auditLogs} />
          </div>
        )}
      </div>
      </div>
      </div>

      {/* Cancel confirmation dialog */}
      <Dialog.Root open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
              <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-[#FFF0F0]">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E53E3E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
                Cancel this booking?
              </Dialog.Title>
              <p className="mt-1.5 text-body-sm leading-relaxed text-gray-500">
                This action cannot be undone.{totalChargeCents > 0 ? ' A refund will be initiated for any paid services.' : ''}
              </p>
              <div className="mt-5 flex gap-2.5">
                <Dialog.Close className="flex-1 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
                  Keep Booking
                </Dialog.Close>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="flex-1 rounded-xl bg-[#E53E3E] px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-white"
                >
                  Cancel Booking
                </button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
