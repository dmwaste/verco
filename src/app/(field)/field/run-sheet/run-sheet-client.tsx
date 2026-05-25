'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
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

interface RunSheetClientProps {
  bookings: Booking[]
}

function getAddress(b: Booking): { street: string; suburb: string } {
  const prop = b.eligible_properties as Booking['eligible_properties']
  // ID bookings have no property — resolve the address from the GPS lookup.
  const full = prop?.formatted_address ?? prop?.address ?? b.geo_address ?? ''
  const parts = full.split(',')
  return {
    street: parts[0]?.trim() ?? full,
    suburb: parts.slice(1).join(',').trim() || '',
  }
}

function IdDetail({ booking }: { booking: Booking }) {
  const wasteTypes = booking.id_waste_types ?? []
  const volume = booking.id_volume
  const photos = booking.photos ?? []
  if (wasteTypes.length === 0 && !volume && photos.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {(wasteTypes.length > 0 || volume) && (
        <div className="flex flex-wrap gap-1.5">
          {wasteTypes.map((w) => (
            <span
              key={w}
              className="inline-flex rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-[11px] font-medium text-[var(--brand)]"
            >
              {w}
            </span>
          ))}
          {volume && (
            <span className="inline-flex rounded-full bg-[#FFF3EA] px-2.5 py-0.5 text-[11px] font-medium text-[#8B4000]">
              {volume}
            </span>
          )}
        </div>
      )}
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {photos.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={url}
              alt={`Evidence ${i + 1}`}
              className="size-14 rounded-lg object-cover"
            />
          ))}
        </div>
      )}
    </div>
  )
}

function getMapsUrl(b: Booking): string | null {
  const prop = b.eligible_properties as Booking['eligible_properties']
  const lat = prop?.latitude ?? b.latitude
  const lng = prop?.longitude ?? b.longitude
  if (lat && lng) return `https://maps.google.com/?q=${lat},${lng}`
  const addr = prop?.formatted_address ?? prop?.address
  if (addr) return `https://maps.google.com/?q=${encodeURIComponent(addr)}`
  return null
}

function getBorderClass(status: BookingStatus): string {
  switch (status) {
    case 'Scheduled': return 'border-l-[var(--brand)]'
    case 'Completed': return 'border-l-[var(--brand-accent-dark)] opacity-70'
    case 'Non-conformance': return 'border-l-[#E53E3E] opacity-70'
    case 'Nothing Presented': return 'border-l-[#FF8C42] opacity-70'
    default: return 'border-l-transparent'
  }
}

export function RunSheetClient({ bookings }: RunSheetClientProps) {
  const router = useRouter()

  const remaining = bookings.filter((b) => b.status === 'Scheduled')
  const completed = bookings.filter((b) =>
    ['Completed', 'Non-conformance', 'Nothing Presented'].includes(b.status)
  )
  const total = bookings.length
  const completedCount = completed.length
  const remainingCount = remaining.length
  const progressPct = total > 0 ? (completedCount / total) * 100 : 0

  function handleQuickComplete(bookingId: string) {
    router.push(`/field/booking/${bookings.find((b) => b.id === bookingId)?.ref ?? ''}`)
  }

  return (
    <div className="flex flex-col gap-3 px-5 pt-4">
      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-[10px] bg-white p-2.5 text-center shadow-sm">
          <div className="font-[family-name:var(--font-heading)] text-title font-bold text-[var(--brand)]">
            {total}
          </div>
          <div className="text-2xs text-gray-500">Total</div>
        </div>
        <div className="rounded-[10px] bg-white p-2.5 text-center shadow-sm">
          <div className="font-[family-name:var(--font-heading)] text-title font-bold text-[var(--brand-accent-dark)]">
            {completedCount}
          </div>
          <div className="text-2xs text-gray-500">Completed</div>
        </div>
        <div className="rounded-[10px] bg-white p-2.5 text-center shadow-sm">
          <div className="font-[family-name:var(--font-heading)] text-title font-bold text-[#FF8C42]">
            {remainingCount}
          </div>
          <div className="text-2xs text-gray-500">Remaining</div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
        <div
          className="h-full rounded-full bg-[var(--brand-accent-dark)] transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Remaining section */}
      {remaining.length > 0 && (
        <>
          <div className="flex items-center justify-between px-0 py-1">
            <span className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[var(--brand)]">
              Remaining
            </span>
            <span className="text-[11px] text-gray-500">
              {remaining.length} bookings
            </span>
          </div>

          {remaining.map((booking) => {
            const { street, suburb } = getAddress(booking)
            const mapsUrl = getMapsUrl(booking)
            const isMud = booking.type === 'MUD'
            const isId = booking.type === 'Illegal Dumping'

            return (
              <div
                key={booking.id}
                className={`flex flex-col gap-2 rounded-xl border-l-4 bg-white p-3.5 shadow-sm ${getBorderClass(booking.status)}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-[family-name:var(--font-heading)] text-xs font-semibold text-[#8FA5B8]">
                      {booking.ref}
                      {isMud && ' · MUD'}
                      {isId && ' · ID'}
                    </div>
                    <div className="text-sm font-semibold leading-snug text-[var(--brand)]">
                      {street}
                    </div>
                    {suburb && (
                      <div className="text-xs text-gray-500">{suburb}</div>
                    )}
                  </div>
                  {isMud ? (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-2xs font-semibold text-gray-700">
                      MUD
                    </span>
                  ) : (
                    <BookingStatusBadge status={booking.status} />
                  )}
                </div>

                {/* ID evidence detail, or service chips for other types */}
                {isId ? (
                  <IdDetail booking={booking} />
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {booking.booking_item.map((item) => (
                      <span
                        key={item.id}
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                          item.is_extra
                            ? 'bg-[#FFF3EA] text-[#8B4000]'
                            : 'bg-[#E8EEF2] text-[var(--brand)]'
                        }`}
                      >
                        {(item.service as { name: string }).name} &times;{' '}
                        {item.no_services}
                        {item.is_extra && ' (extra)'}
                      </span>
                    ))}
                  </div>
                )}

                {/* MUD allocation prompt */}
                {isMud && (
                  <div className="rounded-lg bg-[#FFF3EA] px-2.5 py-2 text-xs text-[#8B4000]">
                    Enter actual allocation count after collection
                  </div>
                )}

                {/* Bottom row */}
                <div className="flex items-center justify-between border-t border-gray-100 pt-1">
                  <div className="flex items-center gap-3">
                    {booking.location && (
                      <span className="text-xs text-gray-500">
                        {booking.location}
                      </span>
                    )}
                    {mapsUrl && (
                      <a
                        href={mapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[11px] font-medium text-[var(--brand-accent-dark)]"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                          <circle cx="12" cy="10" r="3"/>
                        </svg>
                        Maps
                      </a>
                    )}
                  </div>

                  {isMud ? (
                    <Link
                      href={`/field/booking/${booking.ref}?mud=true`}
                      className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      Enter Count
                    </Link>
                  ) : (
                    <div className="flex gap-1.5">
                      <Link
                        href={`/field/booking/${booking.ref}?action=ncn`}
                        className="rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-700"
                      >
                        NCN
                      </Link>
                      <Link
                        href={`/field/booking/${booking.ref}?action=np`}
                        className="rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-700"
                      >
                        NP
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleQuickComplete(booking.id)}
                        className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        Done &#10003;
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </>
      )}

      {/* Completed section */}
      {completed.length > 0 && (
        <>
          <div className="mt-1 flex items-center justify-between px-0 py-1">
            <span className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[var(--brand)]">
              Completed
            </span>
            <span className="text-[11px] text-gray-500">
              {completed.length} bookings
            </span>
          </div>

          {completed.map((booking) => {
            const { street, suburb } = getAddress(booking)
            const isId = booking.type === 'Illegal Dumping'
            return (
              <div
                key={booking.id}
                className={`flex flex-col gap-2 rounded-xl border-l-4 bg-white p-3.5 shadow-sm ${getBorderClass(booking.status)}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-[family-name:var(--font-heading)] text-xs font-semibold text-[#8FA5B8]">
                      {booking.ref}
                    </div>
                    <div className="text-sm font-semibold leading-snug text-[var(--brand)]">
                      {street}
                    </div>
                    {suburb && (
                      <div className="text-xs text-gray-500">{suburb}</div>
                    )}
                  </div>
                  <BookingStatusBadge status={booking.status} />
                </div>
                {isId ? (
                  <IdDetail booking={booking} />
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {booking.booking_item.map((item) => (
                      <span
                        key={item.id}
                        className="inline-flex rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-[11px] font-medium text-[var(--brand)]"
                      >
                        {(item.service as { name: string }).name} &times;{' '}
                        {item.no_services}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}

      {total === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-8 text-center shadow-sm">
          <span className="text-sm font-semibold text-[var(--brand)]">
            No scheduled collections today
          </span>
          <span className="text-xs text-gray-500">
            Check back when collections are assigned.
          </span>
        </div>
      )}
    </div>
  )
}
