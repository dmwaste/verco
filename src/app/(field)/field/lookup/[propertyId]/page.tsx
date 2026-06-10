import Link from 'next/link'
import { redirect } from 'next/navigation'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import { getRangerScope } from '@/lib/field/ranger-scope'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { formatPlaceOutStart, placeOutStart, placeOutVerdict } from '@/lib/booking/place-out'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import { getStopMapsUrl } from '@/lib/stops/labels'
import type { Database } from '@/lib/supabase/types'

type BookingStatus = Database['public']['Enums']['booking_status']

interface PropertyBooking {
  id: string
  ref: string
  status: BookingStatus
  type: string
  created_at: string
  booking_item: Array<{
    no_services: number
    service: { name: string }
    collection_date: { date: string }
  }>
}

interface PropertyBookingPageProps {
  params: Promise<{ propertyId: string }>
}

const UPCOMING_STATUSES: BookingStatus[] = ['Confirmed', 'Scheduled', 'Submitted', 'Pending Payment']

function earliestDate(b: PropertyBooking): string | null {
  const dates = b.booking_item.map((i) => i.collection_date.date).sort()
  return dates[0] ?? null
}

/**
 * Property detail for the ranger lookup: zero-PII booking history + the
 * place-out window, so a sighted pile can be judged on the spot. Structural
 * PII exclusion — never selects contact columns.
 */
export default async function LookupPropertyPage({ params }: PropertyBookingPageProps) {
  const { propertyId } = await params
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'ranger') {
    redirect('/field')
  }

  const scope = await getRangerScope(supabase)
  if (!scope) {
    redirect('/field')
  }

  // Server-side scope re-verify: eligible_properties is public-SELECT, so
  // the URL param must be checked against the ranger's own areas — a pasted
  // id from another tenant must bounce.
  const { data: property } = await supabase
    .from('eligible_properties')
    .select('id, address, formatted_address, latitude, longitude, is_mud, collection_area_id')
    .eq('id', propertyId)
    .maybeSingle()

  if (
    !property ||
    !property.collection_area_id ||
    !scope.areaIds.includes(property.collection_area_id)
  ) {
    redirect('/field/lookup')
  }

  const address = property.formatted_address ?? property.address
  const lat = property.latitude !== null ? Number(property.latitude) : null
  const lng = property.longitude !== null ? Number(property.longitude) : null
  const mapsUrl = getStopMapsUrl(lat, lng, address)

  const BOOKING_COLUMNS = `id, ref, status, type, created_at,
       booking_item(no_services, service!inner(name), collection_date!inner(date))`

  // Two targeted queries — RLS (booking_field_select) scopes both to the
  // ranger's client; no contact columns, ever. The verdict query filters by
  // status server-side so a busy MUD property's history volume can never
  // evict a live booking past a row limit and flip the verdict to "none".
  const [liveResult, historyResult] = await Promise.all([
    supabase
      .from('booking')
      .select(BOOKING_COLUMNS)
      .eq('property_id', propertyId)
      .in('status', UPCOMING_STATUSES)
      .limit(20),
    supabase
      .from('booking')
      .select(BOOKING_COLUMNS)
      .eq('property_id', propertyId)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  // The verdict IS this page's answer — a failed query must render as an
  // error, never as the red "no booking, raise an ID" banner.
  const queryFailed = Boolean(liveResult.error || historyResult.error)

  const now = new Date()
  const today = awstDateFromUtc(now)
  const live = (liveResult.data ?? []) as unknown as PropertyBooking[]
  const history = (historyResult.data ?? []) as unknown as PropertyBooking[]

  // Upcoming: future collections, PLUS Scheduled bookings whose date has
  // passed but were never closed out — exactly the case where a pile is
  // still on the verge and must not read as illegal dumping.
  const upcoming = live
    .filter((b) => (earliestDate(b) ?? '') >= today || b.status === 'Scheduled')
    .sort((a, b) => (earliestDate(a) ?? '').localeCompare(earliestDate(b) ?? ''))
  const upcomingIds = new Set(upcoming.map((b) => b.id))

  // "Last 90 Days" by when the collection happened (or was created — covers
  // date-less drafts): residents book weeks ahead, so created_at alone hides
  // a just-collected booking and invites a wrong ID.
  const cutoffDate = awstDateFromUtc(new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000))
  const cutoffIso = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const recent = history.filter(
    (b) =>
      !upcomingIds.has(b.id) &&
      ((earliestDate(b) ?? '') >= cutoffDate || b.created_at >= cutoffIso),
  )

  // Verdict: pile sighted now — legitimate booking or ID candidate?
  const nextDate = upcoming[0] ? earliestDate(upcoming[0]) : null
  const verdict = placeOutVerdict(nextDate, scope.placeOutHoursBefore, now)
  const windowOpens = nextDate ? placeOutStart(nextDate, scope.placeOutHoursBefore) : null

  const idPrefillHref = `/field/illegal-dumping/new?${new URLSearchParams({
    ...(lat !== null && lng !== null ? { lat: String(lat), lng: String(lng) } : {}),
    address,
  }).toString()}`

  return (
    <div className="flex flex-col gap-3 px-5 pt-4">
      <Link
        href="/field/lookup"
        className="-m-3 flex items-center gap-1.5 p-3 text-body-sm font-medium text-[#8FA5B8]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Lookup
      </Link>

      {/* Property header */}
      <div className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-[family-name:var(--font-heading)] text-base font-bold text-[var(--brand)]">
              {address.split(',')[0]}
            </div>
            <div className="text-xs text-gray-500">
              {address.split(',').slice(1).join(',').trim()}
            </div>
          </div>
          {property.is_mud && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-2xs font-semibold text-gray-700">
              MUD
            </span>
          )}
        </div>
        {mapsUrl && (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-[10px] bg-[#E8EEF2] px-3 text-body-sm font-semibold text-[var(--brand)]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            Open in Google Maps
          </a>
        )}
      </div>

      {/* Query failure — never let an error read as "no booking" */}
      {queryFailed && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3">
          <div className="text-sm font-semibold text-red-800">
            Couldn&apos;t load booking history
          </div>
          <div className="mt-0.5 text-xs text-red-700">
            Check your signal and reload before judging this pile.
          </div>
        </div>
      )}

      {/* Verdict banner */}
      {!queryFailed && verdict === 'open' && nextDate && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3">
          <div className="text-sm font-semibold text-emerald-800">
            Likely a legitimate booking
          </div>
          <div className="mt-0.5 text-xs text-emerald-700">
            Collection booked for {format(new Date(`${nextDate}T00:00:00`), 'EEE d MMM')} and
            the place-out window is open
            {windowOpens && <> (from {formatPlaceOutStart(windowOpens)})</>}.
          </div>
        </div>
      )}
      {!queryFailed && verdict === 'not-yet' && nextDate && windowOpens && (
        <div className="rounded-xl border border-[#FF8C42] bg-[#FFF3EA] px-3.5 py-3">
          <div className="text-sm font-semibold text-[#8B4000]">
            Booking exists — but placed out too early
          </div>
          <div className="mt-0.5 text-xs text-[#8B4000]">
            Collection is {format(new Date(`${nextDate}T00:00:00`), 'EEE d MMM')}; residents may
            place out from {formatPlaceOutStart(windowOpens)}.
          </div>
        </div>
      )}
      {!queryFailed && verdict === 'none' && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3">
          <div className="text-sm font-semibold text-red-800">No upcoming booking</div>
          <div className="mt-0.5 text-xs text-red-700">
            A pile at this address has no booked collection — consider raising an ID.
          </div>
        </div>
      )}

      {/* Raise ID here */}
      <Link
        href={idPrefillHref}
        className="flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[var(--brand)] px-3.5 font-[family-name:var(--font-heading)] text-body font-semibold"
        style={{ color: 'var(--brand-foreground, #FFFFFF)' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="16"/>
          <line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
        Raise ID at this address
      </Link>

      {/* Upcoming bookings */}
      {upcoming.length > 0 && (
        <>
          <div className="flex items-center justify-between px-0 py-1">
            <span className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[var(--brand)]">
              Upcoming
            </span>
            <span className="text-[11px] text-gray-500">{upcoming.length}</span>
          </div>
          {upcoming.map((b) => (
            <BookingCard key={b.id} booking={b} />
          ))}
        </>
      )}

      {/* Recent history */}
      <div className="flex items-center justify-between px-0 py-1">
        <span className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[var(--brand)]">
          Last 90 Days
        </span>
        <span className="text-[11px] text-gray-500">{recent.length}</span>
      </div>
      {recent.length === 0 && (
        <div className="rounded-xl bg-white p-4 text-center text-xs text-gray-500 shadow-sm">
          No recent bookings at this address.
        </div>
      )}
      {recent.map((b) => (
        <BookingCard key={b.id} booking={b} />
      ))}
    </div>
  )
}

function BookingCard({ booking }: { booking: PropertyBooking }) {
  const date = earliestDate(booking)
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-[family-name:var(--font-heading)] text-xs font-semibold text-[#8FA5B8]">
            {booking.ref}
            {booking.type === 'MUD' && ' · MUD'}
          </div>
          {date && (
            <div className="text-sm font-semibold text-[var(--brand)]">
              {format(new Date(`${date}T00:00:00`), 'EEE d MMM yyyy')}
            </div>
          )}
        </div>
        <BookingStatusBadge status={booking.status} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {booking.booking_item.map((item, i) => (
          <span
            key={i}
            className="inline-flex rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-[11px] font-medium text-[var(--brand)]"
          >
            {item.service.name} &times; {item.no_services}
          </span>
        ))}
      </div>
    </div>
  )
}
