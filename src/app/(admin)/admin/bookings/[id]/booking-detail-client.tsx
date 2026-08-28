'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Dialog } from '@base-ui/react/dialog'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { invokeEfWithUserToken } from '@/lib/supabase/invoke-ef-client'
import { invokeEdgeFunction } from '@/lib/supabase/invoke-ef'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import { AddressAutocomplete } from '@/components/booking/address-autocomplete'
import { idWasteTypeLabel, ID_WASTE_TYPES, ID_VOLUMES, ID_PHOTOS_BUCKET, ID_PHOTOS_PREFIX } from '@/lib/booking/id-options'
import { addressMateriallyChanged } from '@/lib/booking/id-edit'
import { matchAddressToArea } from '@/lib/booking/id-area-suggestion'
import { DetailHeader } from '@/components/admin/detail-header'
import { FieldLabel, Input, Select, Textarea } from '@/components/admin/form'
import { LOCATION_OPTIONS, MAX_SERVICE_QTY, type LocationOption } from '@/lib/booking/schemas'
import { buildQuantityEditItems } from '@/lib/booking/quantity-edit-payload'
import { canEditCollectionDetails, canEditIdDetails } from '@/lib/booking/collection-details-edit'
import { isContractorStaff } from '@/lib/auth/roles'
import { confirmBooking, cancelBooking, updateContact, updateCollectionDetails, updateIdDetails, updateNotes, updateBookingQuantities } from './actions'
import { effectiveCapacity, indexPoolDates } from '@/lib/capacity/effective-capacity'
import { capacityBlocksMove, remainingByCategory, unitsByCategory } from '@/lib/booking/collection-details-edit'
import { cn } from '@/lib/utils'
import type { Database } from '@/lib/supabase/types'
import type { ResolvedAuditEntry } from '@/lib/audit/resolve'
import { AuditTimeline } from '@/components/audit-timeline'
import { ExceptionsCard, type AdminExceptionRecord } from '@/components/admin/exceptions-card'
import { BookingTicketsCard, type BookingTicket } from '@/components/admin/booking-tickets-card'
import type { MudContext } from './mud-context'

type BookingStatus = Database['public']['Enums']['booking_status']
type AppRole = Database['public']['Enums']['app_role']

// Contractor date-picker past window (#390.3): bounds the relaxed #378
// closed/past-date fetch so an area's unbounded collection_date history can't
// exceed the PostgREST max-rows cap (default 1000) and silently drop the newest
// (future) dates. Crew-error corrections (#378) are always recent, so 90 days
// is ample. Called inside each queryFn (not render) to stay pure.
const CONTRACTOR_PAST_WINDOW_DAYS = 90
const contractorDateFloor = () =>
  new Date(Date.now() - CONTRACTOR_PAST_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!

interface BookingItem {
  id: string
  service_id: string
  collection_date_id: string
  no_services: number
  actual_services: number | null
  is_extra: boolean
  unit_price_cents: number
  service: { name: string; category?: { code: string } | null }
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
  client_id: string
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
  exceptions: AdminExceptionRecord[]
  tickets: BookingTicket[]
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
  exceptions,
  tickets,
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

  // ── Illegal Dumping details edit (contractor-only; design 2026-08-28) ──
  // Postgres numeric arrives as a string through PostgREST — coerce once so
  // pin-moved comparisons are number-vs-number.
  const origLat = booking.latitude != null ? Number(booking.latitude) : null
  const origLng = booking.longitude != null ? Number(booking.longitude) : null
  const [editGeoAddress, setEditGeoAddress] = useState(booking.geo_address ?? '')
  const [editLat, setEditLat] = useState<number | null>(origLat)
  const [editLng, setEditLng] = useState<number | null>(origLng)
  const [editWasteTypes, setEditWasteTypes] = useState<string[]>(booking.id_waste_types)
  const [editVolume, setEditVolume] = useState(booking.id_volume ?? '')
  const [editPhotos, setEditPhotos] = useState<string[]>(booking.photos)
  const [isUploadingPhotos, setIsUploadingPhotos] = useState(false)
  const [photoUploadError, setPhotoUploadError] = useState<string | null>(null)
  const [isGeocodingEdit, setIsGeocodingEdit] = useState(false)
  const [editPinError, setEditPinError] = useState<string | null>(null)
  // Code of the area the repinned address resolved to, when it disagrees with
  // the booking's area — inline warn, never a block (ID sites are legitimately
  // non-property spots; cross-area corrections go through cancel + re-log).
  const [areaMismatchCode, setAreaMismatchCode] = useState<string | null>(null)
  const [showPinStaleConfirm, setShowPinStaleConfirm] = useState(false)
  // Status-conditional save confirmation (inline role=status banner — the
  // card's idiom; there is no toast primitive on this page).
  const [detailsSaveResult, setDetailsSaveResult] = useState<string | null>(null)
  // Discards stale geocode responses on re-select (intake's geocodeSeqRef pattern).
  const editGeocodeSeqRef = useRef(0)
  const editFileInputRef = useRef<HTMLInputElement>(null)

  // Inline quantity editor (issue #380). Aggregate current per-service quantity
  // (a service can span a free + a paid booking_item row).
  const originalQty = new Map<string, number>()
  const serviceNameById = new Map<string, string>()
  for (const it of booking.booking_item) {
    originalQty.set(it.service_id, (originalQty.get(it.service_id) ?? 0) + it.no_services)
    serviceNameById.set(it.service_id, (it.service as { name: string }).name)
  }
  const serviceLines = Array.from(originalQty.entries()).map(([service_id, qty]) => ({
    service_id,
    name: serviceNameById.get(service_id) ?? 'Service',
    qty,
  }))
  const [editingQuantities, setEditingQuantities] = useState(false)
  const [editQty, setEditQty] = useState<Map<string, number>>(() => new Map(originalQty))
  const [quantityResult, setQuantityResult] = useState<string | null>(null)

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
  // post-dispatch (Scheduled/Completed) it opens to contractor roles so D&M
  // staff can correct a dispatched or wrongly-collected booking's date
  // (VER-285 / #378). The updateCollectionDetails server action + RLS
  // re-enforce this.
  const canEditDetails = canEditCollectionDetails(booking.status, userRole)

  // ID-specific fields are contractor-only at every editable status — a
  // client-tier admin editing pre-dispatch sees them as read-only rows.
  const canEditId = isId && canEditIdDetails(booking.status, userRole)
  const editPinExists = editLat !== null && editLng !== null
  const editPinMoved = editLat !== origLat || editLng !== origLng

  // Contractor (D&M) staff may reschedule into a closed or past/earlier date to
  // correct a crew collection error (D1, #378). Client-tier admins keep the
  // resident date filter (open, today-or-future only). The updateCollectionDetails
  // server action re-validates this — the relaxed filter is a convenience, not
  // the security boundary.
  const isContractor = isContractorStaff(userRole)
  // Units per capacity bucket, for the client-tier date-move capacity gate (#426).
  const bookingUnits = unitsByCategory(
    booking.booking_item.map((bi) => ({ no_services: bi.no_services, category_code: bi.service.category?.code ?? null })),
  )
  const currentDateId = booking.booking_item[0]?.collection_date_id ?? null

  // Inline quantity editing (issue #380) is offered only for Confirmed,
  // non-MUD, non-ID bookings. Pending Payment (unpaid / open Stripe session) and
  // Scheduled (field stops exist) route to cancel & rebook; MUD has a per-FY cap
  // double-spend risk. The updateBookingQuantities server action + EF re-enforce.
  const canEditQuantities =
    canEditDetails && booking.status === 'Confirmed' && !isMud && !isId
  const quantitiesChanged = serviceLines.some(
    (l) => (editQty.get(l.service_id) ?? l.qty) !== l.qty,
  )

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

  // Fetch available collection dates for inline date picker. Contractor staff
  // see closed + past dates too (crew-error correction, #378), bounded to the
  // CONTRACTOR_PAST_WINDOW_DAYS floor; client-tier admins keep the
  // open/today-or-future resident filter.
  const { data: availableDates } = useQuery({
    queryKey: ['collection-dates-admin', booking.collection_area_id, isContractor],
    enabled: editingDetails && !!booking.collection_area_id,
    queryFn: async () => {
      let query = supabase
        .from('collection_date')
        .select(
          `id, date, is_open,
           bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
           anc_capacity_limit, anc_units_booked, anc_is_closed,
           id_capacity_limit, id_units_booked, id_is_closed`,
        )
        .eq('collection_area_id', booking.collection_area_id!)
      if (!isContractor) {
        query = query
          .eq('is_open', true)
          .gte('date', new Date().toISOString().split('T')[0])
      } else {
        query = query.gte('date', contractorDateFloor())
      }
      const { data } = await query.order('date', { ascending: true })
      return data ?? []
    },
  })

  const { data: poolDates } = useQuery({
    queryKey: ['pool-dates-admin', poolId, isContractor],
    enabled: editingDetails && !!poolId,
    queryFn: async () => {
      if (!poolId) return []
      let query = supabase
        .from('collection_date_pool')
        .select(
          `date,
           bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
           anc_capacity_limit, anc_units_booked, anc_is_closed,
           id_capacity_limit, id_units_booked, id_is_closed`,
        )
        .eq('capacity_pool_id', poolId)
      // Contractor staff need past pool dates too (crew-error correction, #378),
      // bounded to the CONTRACTOR_PAST_WINDOW_DAYS floor (#390.3) — pooled
      // areas' date rows accrue daily.
      if (!isContractor) {
        query = query.gte('date', new Date().toISOString().split('T')[0])
      } else {
        query = query.gte('date', contractorDateFloor())
      }
      const { data } = await query
      return data ?? []
    },
  })

  const poolByDate = indexPoolDates(poolDates ?? [])

  // Today (ISO yyyy-mm-dd) for flagging closed/past dates in the picker (#378).
  const today = new Date().toISOString().split('T')[0]!

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
    // Booking-anchored (#452): the RPC derives the contact from the booking,
    // so a caller can never point the write at an arbitrary contact id.
    const result = await updateContact(booking.id, {
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

  // Address search selection → re-geocode (place_id → lat/lng) and move the
  // pin; free-typing the label input never touches the pin. Mirrors the admin
  // ID intake form's handleAddressSelect (id-request-form.tsx).
  async function handleEditAddressSelect(placeId: string, description: string) {
    const seq = ++editGeocodeSeqRef.current
    setEditGeoAddress(description)
    setEditPinError(null)
    setAreaMismatchCode(null)
    setIsGeocodingEdit(true)
    try {
      const data = await invokeEdgeFunction<{
        address: string | null
        latitude: number | null
        longitude: number | null
        error?: string
      }>('google-places-proxy', { place_id: placeId, type: 'geocode' })
      if (seq !== editGeocodeSeqRef.current) return
      if (data.error || typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
        setEditPinError('Could not pin coordinates for that address — the existing pin is unchanged.')
      } else {
        setEditLat(data.latitude)
        setEditLng(data.longitude)
        // Soft area consistency (warn, never block): does the new address
        // resolve to a DIFFERENT area than the booking's? Scoped to the
        // booking's client (collection_area is public-SELECT — CLAUDE.md §21).
        try {
          const { data: areas } = await supabase
            .from('collection_area')
            .select('id, code')
            .eq('client_id', booking.client_id)
          const areaIds = (areas ?? []).map((a) => a.id)
          const matched = await matchAddressToArea(supabase, {
            placeId,
            address: description,
            areaIds,
          })
          if (seq !== editGeocodeSeqRef.current) return
          if (matched && matched !== booking.collection_area_id) {
            setAreaMismatchCode(areas?.find((a) => a.id === matched)?.code ?? 'another area')
          }
        } catch {
          // Advisory only — swallow lookup failures.
        }
      }
    } catch {
      if (seq !== editGeocodeSeqRef.current) return
      setEditPinError('Address lookup failed — the existing pin is unchanged.')
    } finally {
      if (seq === editGeocodeSeqRef.current) setIsGeocodingEdit(false)
    }
  }

  function toggleEditWasteType(type: string) {
    setEditWasteTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    )
  }

  async function handleEditPhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return
    setIsUploadingPhotos(true)
    setPhotoUploadError(null)
    const results = await Promise.all(
      Array.from(files).map(async (file) => {
        const ext = file.name.split('.').pop() ?? 'jpg'
        const path = `${ID_PHOTOS_PREFIX}/${crypto.randomUUID()}.${ext}`
        try {
          const { data, error: uploadError } = await supabase.storage
            .from(ID_PHOTOS_BUCKET)
            .upload(path, file)
          if (uploadError || !data) return { ok: false as const }
          const { data: urlData } = supabase.storage
            .from(ID_PHOTOS_BUCKET)
            .getPublicUrl(data.path)
          return { ok: true as const, url: urlData.publicUrl }
        } catch {
          return { ok: false as const }
        }
      })
    )
    const newUrls = results.filter((r) => r.ok).map((r) => r.url)
    const failedCount = results.length - newUrls.length
    if (newUrls.length > 0) setEditPhotos((prev) => [...prev, ...newUrls])
    if (failedCount > 0) {
      // Per-file failure surfacing — a failed upload never silently drops the
      // photo or blocks the ones that succeeded.
      setPhotoUploadError(
        `Couldn't upload ${failedCount} photo${failedCount > 1 ? 's' : ''}. Check your connection and try again.`
      )
    }
    if (editFileInputRef.current) editFileInputRef.current.value = ''
    setIsUploadingPhotos(false)
  }

  /** Only photos added THIS session are removable — persisted evidence is
   *  append-only (server action + DB trigger both enforce it). */
  function removeSessionPhoto(url: string) {
    if (booking.photos.includes(url)) return
    setEditPhotos((prev) => prev.filter((u) => u !== url))
  }

  function resetIdEditState() {
    setEditGeoAddress(booking.geo_address ?? '')
    setEditLat(origLat)
    setEditLng(origLng)
    setEditWasteTypes(booking.id_waste_types)
    setEditVolume(booking.id_volume ?? '')
    setEditPhotos(booking.photos)
    setEditPinError(null)
    setPhotoUploadError(null)
    setAreaMismatchCode(null)
  }

  async function handleSaveDetails() {
    if (canEditId) {
      if (editWasteTypes.length === 0) {
        setError('Select at least one waste type.')
        return
      }
      if (!editVolume) {
        setError('Select an estimated volume.')
        return
      }
      if (!editGeoAddress.trim()) {
        setError('Address is required.')
        return
      }
      // Pin-stale guard (the VIN-YVMSIN class): the label changed materially
      // but the pin didn't move — crews are routed by the pin, so saving a
      // corrected label over a stale pin needs an explicit decision.
      // Suppressed for pinless bookings (nothing to be stale).
      if (
        editPinExists &&
        !editPinMoved &&
        addressMateriallyChanged(booking.geo_address, editGeoAddress)
      ) {
        setShowPinStaleConfirm(true)
        return
      }
    }
    await doSaveDetails()
  }

  async function doSaveDetails() {
    setShowPinStaleConfirm(false)
    setIsPending(true)
    setError(null)
    setDetailsSaveResult(null)

    // ID fields save FIRST: its optimistic-concurrency token is the
    // page-rendered updated_at, and the booking_updated_at trigger bumps
    // updated_at on EVERY write — so any sibling save before this one would
    // make the token stale and every ID save false-conflict.
    if (canEditId) {
      const idResult = await updateIdDetails(booking.id, {
        geo_address: editGeoAddress.trim(),
        latitude: editLat,
        longitude: editLng,
        waste_types: editWasteTypes,
        volume: editVolume,
        photo_urls: editPhotos,
        expected_updated_at: booking.updated_at,
      })
      if (!idResult.ok) {
        setError(idResult.error)
        setIsPending(false)
        return
      }
    }

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
    if (canEditId) {
      // Status-conditional: "the crew's stop updates" is only true while
      // Pending stops exist (Scheduled). Confirmed pre-T-3 has no stops yet;
      // Completed stops are terminal and deliberately never touched.
      const today = new Date().toISOString().split('T')[0]!
      const isCollectionToday = collectionDateStr === today
      setDetailsSaveResult(
        booking.status === 'Scheduled'
          ? isCollectionToday
            ? "Saved. The crew's stop updates on the next hourly sync — today's route is already dispatched, phone ops for same-day corrections."
            : "Saved. The crew's stop updates on the next hourly sync."
          : booking.status === 'Completed'
            ? 'Saved — record updated.'
            : 'Saved.'
      )
    }
    setEditingDetails(false)
    setIsPending(false)
    router.refresh()
  }

  function setQty(serviceId: string, next: number) {
    setEditQty((prev) => new Map(prev).set(serviceId, Math.min(MAX_SERVICE_QTY, Math.max(1, next))))
  }

  async function handleSaveQuantities() {
    setIsPending(true)
    setError(null)
    setQuantityResult(null)
    // items = the admin's TARGET quantities; expectedItems = the ORIGINAL
    // quantities this page rendered (the #387.1 concurrency baseline). serviceLines
    // is derived from the server snapshot at page load, so it still reflects what
    // the admin saw even if this editor was left open for minutes.
    const { items, expectedItems } = buildQuantityEditItems(serviceLines, editQty)
    const result = await updateBookingQuantities(booking.id, items, expectedItems)
    if (!result.ok) {
      setError(result.error)
      setIsPending(false)
      return
    }
    setEditingQuantities(false)
    setIsPending(false)
    const { refundOwedCents, refundState } = result.data
    const dollars = (refundOwedCents / 100).toFixed(2)
    if (refundState === 'failed' && refundOwedCents > 0) {
      // Quantities DID update, but no refund_request exists — never claim a
      // refund is on its way when nothing was recorded.
      setError(
        `Quantities were updated, but the $${dollars} refund could not be recorded — no refund request exists. Process it manually.`,
      )
    } else {
      setQuantityResult(
        refundState === 'initiated'
          ? `Quantities updated. A refund of $${dollars} has been initiated.`
          : refundState === 'queued'
            ? `Quantities updated. A refund of $${dollars} is awaiting admin approval on the Refunds page.`
            : 'Quantities updated.',
      )
    }
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

        {detailsSaveResult && (
          <div role="status" className="mb-3 rounded-lg border border-status-success bg-status-success-bg px-3 py-2 text-body-sm text-status-success">
            {detailsSaveResult}
          </div>
        )}

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
                      {idWasteTypeLabel(w)}
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
            {/* Illegal Dumping details — contractor-only edit; client-tier
                sees read-only rows (never disabled controls, never omission).
                Rendered ABOVE the generic fields: the address is what this
                edit affordance exists to correct (design 2026-08-28). */}
            {isId && canEditId && (
              <div className="flex flex-col gap-3 rounded-lg border-[1.5px] border-gray-100 bg-gray-50/60 p-3">
                <span className="text-caption font-semibold uppercase tracking-wide text-gray-500">
                  Illegal Dumping Details
                </span>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="bd-id-address-search" className="mb-0">
                    Search an address to move the pin
                  </FieldLabel>
                  <AddressAutocomplete
                    inputId="bd-id-address-search"
                    onSelect={handleEditAddressSelect}
                    placeholder="Start typing the street address..."
                  />
                </div>
                <div
                  role="status"
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium',
                    editPinError
                      ? 'bg-status-error-bg text-status-error'
                      : editPinExists
                        ? 'bg-status-success-bg text-status-success'
                        : 'bg-status-warn-bg text-status-warn'
                  )}
                >
                  <div
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      editPinError ? 'bg-status-error' : editPinExists ? 'bg-status-success' : 'bg-status-warn'
                    )}
                  />
                  {isGeocodingEdit
                    ? 'Pinning location...'
                    : editPinError
                      ? editPinError
                      : editPinExists
                        ? `Pin: ${editLat?.toFixed(5)}, ${editLng?.toFixed(5)} · ${editPinMoved ? 'updated' : 'unchanged'}`
                        : 'No pin set — crews rely on the description'}
                </div>
                {areaMismatchCode && (
                  <div className="rounded-lg bg-status-warn-bg px-3 py-2 text-xs font-medium text-status-warn">
                    This address looks like it belongs to {areaMismatchCode}. Cross-area
                    corrections need cancel + re-log.
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="bd-id-geo-address" className="mb-0">
                    Location description shown to the crew
                  </FieldLabel>
                  <Input
                    id="bd-id-geo-address"
                    type="text"
                    value={editGeoAddress}
                    onChange={(e) => setEditGeoAddress(e.target.value)}
                    className="bg-white py-2 text-sm"
                  />
                  <p className="text-caption text-gray-500">
                    Edit freely — the pin only moves when you pick a searched address above.
                  </p>
                </div>
                <fieldset>
                  <legend className="text-xs font-medium text-gray-700">Type of waste</legend>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    {ID_WASTE_TYPES.map((type) => (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={editWasteTypes.includes(type)}
                        onClick={() => toggleEditWasteType(type)}
                        className={cn(
                          'rounded-lg border-[1.5px] px-3 py-2 text-center text-xs font-medium transition-colors',
                          editWasteTypes.includes(type)
                            ? 'border-[#293F52] bg-[#E8EEF2] text-[#293F52]'
                            : 'border-gray-100 bg-white text-gray-700 hover:bg-gray-50'
                        )}
                      >
                        {idWasteTypeLabel(type)}
                      </button>
                    ))}
                    {/* Legacy tags not in the current offering stay saveable if untouched */}
                    {editWasteTypes
                      .filter((t) => !(ID_WASTE_TYPES as readonly string[]).includes(t))
                      .map((type) => (
                        <button
                          key={type}
                          type="button"
                          aria-pressed
                          onClick={() => toggleEditWasteType(type)}
                          className="rounded-lg border-[1.5px] border-[#293F52] bg-[#E8EEF2] px-3 py-2 text-center text-xs font-medium text-[#293F52]"
                        >
                          {idWasteTypeLabel(type)}
                        </button>
                      ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-xs font-medium text-gray-700">Estimated volume</legend>
                  <div className="mt-1.5 flex max-w-sm gap-1.5">
                    {ID_VOLUMES.map((v) => (
                      <button
                        key={v.label}
                        type="button"
                        aria-pressed={editVolume.startsWith(v.label)}
                        onClick={() => setEditVolume(`${v.label} (${v.sub})`)}
                        className={cn(
                          'flex flex-1 flex-col items-center rounded-lg border-[1.5px] px-2 py-2 text-center text-xs font-medium transition-colors',
                          editVolume.startsWith(v.label)
                            ? 'border-[#293F52] bg-[#E8EEF2] text-[#293F52]'
                            : 'border-gray-100 bg-white text-gray-700 hover:bg-gray-50'
                        )}
                      >
                        {v.label}
                        <span className="text-2xs font-normal text-gray-500">{v.sub}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-gray-700">Evidence photos</span>
                  {editPhotos.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {editPhotos.map((url) => {
                        const isPersisted = booking.photos.includes(url)
                        return (
                          <div key={url} className="relative">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={url}
                              alt={isPersisted ? 'Evidence photo (locked)' : 'New photo (removable until save)'}
                              title={
                                isPersisted
                                  ? 'Evidence is append-only — corrections happen by adding, never removing.'
                                  : undefined
                              }
                              className="size-16 rounded-lg object-cover"
                            />
                            {!isPersisted && (
                              <button
                                type="button"
                                aria-label="Remove photo added this session"
                                onClick={() => removeSessionPhoto(url)}
                                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-[#293F52] text-xs font-semibold text-white"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <input
                    ref={editFileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleEditPhotoUpload}
                    className="text-xs text-gray-700 file:mr-2 file:rounded-lg file:border-0 file:bg-[#E8EEF2] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[#293F52]"
                  />
                  {isUploadingPhotos && (
                    <p role="status" className="text-caption text-gray-500">Uploading…</p>
                  )}
                  {photoUploadError && (
                    <p role="alert" className="rounded-lg bg-status-error-bg px-3 py-2 text-xs font-medium text-status-error">
                      {photoUploadError}
                    </p>
                  )}
                  <p className="text-caption text-gray-500">
                    Existing photos are evidence and can&apos;t be removed. Photos added now are
                    removable until you save.
                  </p>
                </div>
              </div>
            )}
            {isId && !canEditId && (
              <div className="flex flex-col gap-2.5 rounded-lg border-[1.5px] border-gray-100 bg-gray-50/60 p-3">
                <span className="text-caption font-semibold uppercase tracking-wide text-gray-500">
                  Illegal Dumping Details
                </span>
                <div className="flex gap-3">
                  <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Address</span>
                  <span className="min-w-0 flex-1 break-words text-body-sm text-gray-900">{booking.geo_address ?? '—'}</span>
                </div>
                <div className="flex gap-3">
                  <span className="w-[120px] shrink-0 text-xs font-medium text-gray-500">Waste</span>
                  <span className="min-w-0 flex-1 break-words text-body-sm text-gray-900">
                    {booking.id_waste_types.map(idWasteTypeLabel).join(', ') || '—'}
                    {booking.id_volume ? ` · ${booking.id_volume}` : ''}
                  </span>
                </div>
                <p className="text-caption text-gray-500">
                  Illegal dumping details can only be changed by D&amp;M.
                </p>
              </div>
            )}
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
                  // Capacity gate for client-tier (#426): a date without room for
                  // this booking's units is shown but not selectable; contractor
                  // keeps the override. Mirrors updateCollectionDetails.
                  const full =
                    d.id !== currentDateId &&
                    capacityBlocksMove(userRole, bookingUnits, remainingByCategory(cap))
                  // Flag the dates only contractor staff see, so a crew-error
                  // correction into a closed/past date is deliberate (#378).
                  const flags = [
                    d.is_open === false ? 'closed' : null,
                    d.date < today ? 'past' : null,
                    full ? 'full' : null,
                  ].filter(Boolean)
                  const suffix = flags.length ? ` · ${flags.join(', ')}` : ''
                  return (
                    <option key={d.id} value={d.id} disabled={full}>
                      {format(new Date(d.date + 'T00:00:00'), 'EEE d MMM yyyy')} ({spots} spots){suffix}
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
                disabled={isPending || (canEditId && (isUploadingPhotos || isGeocodingEdit))}
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
                  resetIdEditState()
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

      {/* Services — inline quantity editor (issue #380), same collection date */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-caption font-semibold uppercase tracking-wide text-gray-500">
            Services
          </span>
          {canEditQuantities && !editingQuantities && (
            <button
              type="button"
              onClick={() => {
                setQuantityResult(null)
                setEditQty(new Map(originalQty))
                setEditingQuantities(true)
              }}
              className="text-gray-400 hover:text-[#293F52]"
              aria-label="Edit quantities"
            >
              <PencilIcon />
            </button>
          )}
          {isMud && canEdit && (
            <span
              className="text-2xs text-gray-500"
              title="Edit services not supported for MUD bookings. Cancel this booking and rebook from the property page."
            >
              Cancel &amp; rebook to edit
            </span>
          )}
          {!isMud && !isId && canEdit && canEditDetails && !canEditQuantities && (
            <span
              className="text-2xs text-gray-500"
              title="Service quantities can only be edited on Confirmed bookings. Cancel and rebook to change services."
            >
              Cancel &amp; rebook to edit
            </span>
          )}
        </div>

        {editingQuantities ? (
          <div className="flex flex-col gap-2.5">
            {serviceLines.map((line) => {
              const qty = editQty.get(line.service_id) ?? line.qty
              return (
                <div
                  key={line.service_id}
                  className="flex items-center justify-between rounded-lg bg-gray-50 px-2.5 py-2 text-body-sm"
                >
                  <span className="text-gray-900">{line.name}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label={`Decrease ${line.name}`}
                      onClick={() => setQty(line.service_id, qty - 1)}
                      disabled={qty <= 1}
                      className="flex size-7 items-center justify-center rounded-md border-[1.5px] border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      &minus;
                    </button>
                    <span className="w-6 text-center font-semibold tabular-nums text-gray-900">{qty}</span>
                    <button
                      type="button"
                      aria-label={`Increase ${line.name}`}
                      onClick={() => setQty(line.service_id, qty + 1)}
                      disabled={qty >= MAX_SERVICE_QTY}
                      className="flex size-7 items-center justify-center rounded-md border-[1.5px] border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      +
                    </button>
                  </div>
                </div>
              )
            })}
            <p className="text-xs leading-relaxed text-gray-500">
              Reductions refund any paid extras automatically, keeping the same collection date.
              Adding a paid extra isn&rsquo;t supported here &mdash; cancel &amp; rebook.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSaveQuantities}
                disabled={isPending || !quantitiesChanged}
                className="flex-1 rounded-lg bg-[#293F52] px-3 py-2 text-body-sm font-semibold text-white disabled:opacity-50"
              >
                {isPending ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingQuantities(false)
                  setEditQty(new Map(originalQty))
                }}
                className="flex-1 rounded-lg border-[1.5px] border-gray-200 bg-white px-3 py-2 text-body-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
            {editServicesUrl && (
              <Link href={editServicesUrl} className="text-xs font-medium text-[#293F52] underline">
                Add or change service types (full editor) &rarr;
              </Link>
            )}
          </div>
        ) : (
        <div className="flex flex-col gap-1.5">
          {quantityResult && (
            <div role="status" className="mb-1 rounded-lg border border-status-success bg-status-success-bg px-3 py-2 text-body-sm text-status-success">
              {quantityResult}
            </div>
          )}
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
        )}
      </div>

      </div>

      {/* Activity — right column */}
      <div className="flex min-w-0 flex-col gap-4">
        <ExceptionsCard records={exceptions} />
        <BookingTicketsCard tickets={tickets} />
        {auditLogs.length > 0 && (
          <div className="rounded-xl bg-white shadow-sm">
            <AuditTimeline entries={auditLogs} />
          </div>
        )}
      </div>
      </div>
      </div>

      {/* Cancel confirmation dialog */}
      {/* Pin-stale confirm (VIN-YVMSIN class): label changed materially, pin
          didn't move. Blocking dialog — Base UI traps focus and closes on
          Escape. For non-addressable sites (no prediction exists) the copy
          states the accepted limitation honestly. */}
      <Dialog.Root open={showPinStaleConfirm} onOpenChange={setShowPinStaleConfirm}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
              <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
                Keep the existing map pin?
              </Dialog.Title>
              <p className="mt-1.5 text-body-sm leading-relaxed text-gray-500">
                You changed the address but kept the existing map pin
                {editPinExists ? ` (${editLat?.toFixed(5)}, ${editLng?.toFixed(5)})` : ''}.
                Crews are routed by the pin, not the text. To move the pin, pick an address
                from the search suggestions — if the site has no street address, the pin can
                only be corrected by ops.
              </p>
              <div className="mt-5 flex gap-2.5">
                <Dialog.Close className="flex-1 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
                  Back — pick an address
                </Dialog.Close>
                <button
                  type="button"
                  onClick={() => void doSaveDetails()}
                  className="flex-1 rounded-xl bg-[#293F52] px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-white"
                >
                  Keep pin &amp; save
                </button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

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
