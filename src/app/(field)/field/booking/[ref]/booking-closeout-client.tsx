'use client'

import { useState } from 'react'
import Link from 'next/link'
import { VercoButton } from '@/components/ui/verco-button'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import { NcnForm } from './ncn-form'
import { MudAllocationForm } from './mud-allocation-form'
import { completeBooking, raiseNothingPresented } from './actions'
import type { Database } from '@/lib/supabase/types'

type BookingStatus = Database['public']['Enums']['booking_status']

interface BookingItem {
  id: string
  no_services: number
  is_extra: boolean
  unit_price_cents: number
  actual_services: number | null
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
  latitude: number | null
  longitude: number | null
  geo_address: string | null
  photos: string[]
  id_waste_types: string[]
  id_volume: string | null
  collection_area: { name: string; code: string }
  eligible_properties: {
    address: string
    formatted_address: string | null
    latitude: number | null
    longitude: number | null
  } | null
  booking_item: BookingItem[]
}

function CloseoutInner({ booking }: { booking: Booking }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const action = searchParams.get('action')
  const isMud = searchParams.get('mud') === 'true' || booking.type === 'MUD'

  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showNpForm, setShowNpForm] = useState(action === 'np')

  const isId = booking.type === 'Illegal Dumping'
  const prop = booking.eligible_properties as Booking['eligible_properties']
  // ID bookings have no property — fall back to the GPS-resolved address.
  const address = prop?.formatted_address ?? prop?.address ?? booking.geo_address ?? ''
  const lat = prop?.latitude ?? booking.latitude
  const lng = prop?.longitude ?? booking.longitude
  const mapsUrl = lat && lng
    ? `https://maps.google.com/?q=${lat},${lng}`
    : `https://maps.google.com/?q=${encodeURIComponent(address)}`

  const servicesSummary = booking.booking_item
    .map((i) => `${(i.service as { name: string }).name} \u00d7 ${i.no_services}`)
    .join(', ')

  const isScheduled = booking.status === 'Scheduled'

  // Show NCN form
  if (action === 'ncn' && isScheduled) {
    return (
      <NcnForm
        bookingId={booking.id}
        bookingRef={booking.ref}
        address={address}
      />
    )
  }

  // Show MUD allocation form when any item still needs an actual_services
  // count, OR when the crew explicitly clicked "Edit counts" via ?recount=1.
  // Once all are filled (and ?recount is absent) the close-out actions render
  // below.
  const wantsRecount = searchParams.get('recount') === '1'
  const needsMudCounts =
    isMud &&
    isScheduled &&
    booking.booking_item.length > 0 &&
    (wantsRecount ||
      booking.booking_item.some((i) => i.actual_services === null || i.actual_services === undefined))

  if (needsMudCounts) {
    return (
      <MudAllocationForm
        bookingId={booking.id}
        bookingRef={booking.ref}
        address={address}
        items={booking.booking_item.map((i) => ({
          id: i.id,
          service_name: (i.service as { name: string }).name,
          pre_booked: i.no_services,
          initial_count: i.actual_services,
        }))}
      />
    )
  }

  async function handleComplete() {
    setIsPending(true)
    setError(null)
    const result = await completeBooking(booking.id)
    if (!result.ok) {
      setError(result.error)
      setIsPending(false)
      return
    }
    router.push('/field/run-sheet')
    router.refresh()
  }

  async function handleNp() {
    if (!showNpForm) {
      setShowNpForm(true)
      return
    }
    setIsPending(true)
    setError(null)
    const result = await raiseNothingPresented(booking.id, '', [], false)
    if (!result.ok) {
      setError(result.error)
      setIsPending(false)
      return
    }
    router.push('/field/run-sheet')
    router.refresh()
  }

  return (
    <>
      {/* Panel header */}
      <div className="shrink-0 border-b border-gray-100 bg-white px-5 py-4">
        <Link
          href="/field/run-sheet"
          className="mb-2.5 flex items-center gap-1.5 text-body-sm font-medium text-[#8FA5B8]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Run Sheet
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <div className="font-[family-name:var(--font-heading)] text-base font-bold text-[var(--brand)]">
              {booking.ref}
            </div>
            <div className="mt-0.5 text-body-sm text-gray-500">{address}</div>
          </div>
          <BookingStatusBadge status={booking.status} />
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 pb-24 pt-4">
        {/* Collection details — NO PII */}
        <div className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm">
          <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
            Collection Details
          </div>
          <div className="flex justify-between border-b border-gray-100 py-1 text-body-sm">
            <span className="text-xs text-gray-500">Location</span>
            <span className="font-medium text-gray-900">{booking.location ?? '—'}</span>
          </div>
          <div className="flex justify-between border-b border-gray-100 py-1 text-body-sm">
            <span className="text-xs text-gray-500">Services</span>
            <span className="font-medium text-gray-900">{servicesSummary}</span>
          </div>
          <div className="flex justify-between py-1 text-body-sm">
            <span className="text-xs text-gray-500">Notes</span>
            <span className="font-medium italic text-gray-500">
              {booking.notes ?? '—'}
            </span>
          </div>
        </div>

        {/* Illegal Dumping evidence */}
        {isId &&
          (booking.id_waste_types.length > 0 ||
            booking.id_volume ||
            booking.photos.length > 0) && (
            <div className="flex flex-col gap-2.5 rounded-xl bg-white p-3.5 shadow-sm">
              <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
                Illegal Dumping
              </div>
              {(booking.id_waste_types.length > 0 || booking.id_volume) && (
                <div className="flex flex-wrap gap-1.5">
                  {booking.id_waste_types.map((w) => (
                    <span
                      key={w}
                      className="inline-flex rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-[11px] font-medium text-[var(--brand)]"
                    >
                      {w}
                    </span>
                  ))}
                  {booking.id_volume && (
                    <span className="inline-flex rounded-full bg-[#FFF3EA] px-2.5 py-0.5 text-[11px] font-medium text-[#8B4000]">
                      {booking.id_volume}
                    </span>
                  )}
                </div>
              )}
              {booking.photos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {booking.photos.map((url, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={url}
                      alt={`Evidence ${i + 1}`}
                      className="size-20 rounded-lg object-cover"
                    />
                  ))}
                </div>
              )}
            </div>
          )}

        {/* Maps link */}
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 rounded-[10px] bg-[#E8EEF2] px-3 py-3 text-body-sm font-semibold text-[var(--brand)]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          Open in Google Maps
        </a>

        {/* MUD counts confirmation banner — only when all counts are saved */}
        {isMud && isScheduled && (
          <div className="rounded-[10px] border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-[12px] text-emerald-800">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Counts saved</span>
              <Link
                href={`/field/booking/${booking.ref}?recount=1`}
                className="text-[11px] font-medium text-emerald-700 underline"
              >
                Edit counts
              </Link>
            </div>
            <div className="mt-1 space-y-0.5">
              {booking.booking_item.map((i) => (
                <div key={i.id} className="flex justify-between text-[11px]">
                  <span>{(i.service as { name: string }).name}</span>
                  <span className="font-mono">{i.actual_services ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Close out actions */}
        {isScheduled && (
          <div className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm">
            <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
              Close Out
            </div>
            <div className="flex flex-col gap-2">
              <VercoButton
                variant="accent"
                className="w-full"
                type="button"
                onClick={handleComplete}
                disabled={isPending}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                {isPending ? 'Completing...' : 'Mark as Completed'}
              </VercoButton>
              <div className="flex gap-2">
                <VercoButton
                  variant="destructive"
                  size="sm"
                  href={`/field/booking/${booking.ref}?action=ncn`}
                  className="flex-1"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  </svg>
                  Raise NCN
                </VercoButton>
                <VercoButton
                  variant="warning"
                  size="sm"
                  type="button"
                  onClick={handleNp}
                  disabled={isPending}
                  className="flex-1"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                  </svg>
                  Nothing Presented
                </VercoButton>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    </>
  )
}

export function BookingCloseoutClient({ booking }: { booking: Booking }) {
  return (
    <Suspense>
      <CloseoutInner booking={booking} />
    </Suspense>
  )
}
