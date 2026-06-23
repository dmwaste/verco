'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Dialog } from '@base-ui/react/dialog'
import { format, differenceInDays } from 'date-fns'
import { cancellationCutoff } from '@/lib/booking/cancellation-cutoff'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import { VercoButton } from '@/components/ui/verco-button'
import { createClient } from '@/lib/supabase/client'
import { invokeEfWithUserToken } from '@/lib/supabase/invoke-ef-client'
import { cancelBooking, disputeNcn, disputeNp } from './actions'
import { getStatusStyle } from '@/lib/ui/status-styles'
import type { Database } from '@/lib/supabase/types'

type BookingStatus = Database['public']['Enums']['booking_status']
type TicketStatus = Database['public']['Enums']['ticket_status']
type TicketCategory = Database['public']['Enums']['ticket_category']

interface BookingItem {
  id: string
  service_id: string
  collection_date_id: string
  no_services: number
  is_extra: boolean
  unit_price_cents: number
  service: { name: string }
  collection_date: { date: string }
}

interface Ticket {
  id: string
  display_id: string
  subject: string
  status: TicketStatus
  category: TicketCategory
  created_at: string
}

interface Booking {
  id: string
  ref: string
  status: BookingStatus
  type: string
  location: string | null
  notes: string | null
  created_at: string
  property_id: string | null
  collection_area_id: string | null
  collection_area: { name: string }
  contact: { full_name: string; email: string; mobile_e164: string | null } | null
  property: { formatted_address: string | null; address: string } | null
  booking_item: BookingItem[]
}

interface NcnInfo {
  id: string
  reason: string
  status: string
  photos: string[]
  reported_at: string
  rescheduled_booking: { ref: string } | null
}

interface NpInfo {
  id: string
  status: string
  photos: string[]
  reported_at: string
  contractor_fault: boolean
  rescheduled_booking: { ref: string } | null
}

interface BookingDetailClientProps {
  booking: Booking
  tickets: Ticket[]
  receiptUrl: string | null
  ncn: NcnInfo | null
  np: NpInfo | null
  paymentSuccess?: boolean
  placeOutHoursBefore: number
  serviceName: string | null
}

function formatPlaceOutWindow(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24
    return `${days} ${days === 1 ? 'day' : 'days'}`
  }
  return `${hours} hours`
}


const CATEGORY_LABELS: Record<TicketCategory, string> = {
  general: 'General',
  booking: 'Booking Enquiry',
  billing: 'Billing',
  service: 'Service Issue',
  complaint: 'Complaint',
  other: 'Other',
}

function getCollectionDate(booking: Booking): string | null {
  if (booking.booking_item.length === 0) return null
  return booking.booking_item[0]?.collection_date?.date ?? null
}

function getCutoffDate(collectionDateStr: string): Date {
  return cancellationCutoff(collectionDateStr)
}

function formatMobile(e164: string): string {
  // +614XXXXXXXX → 04XX XXX XXX
  if (e164.startsWith('+61') && e164.length === 12) {
    const local = '0' + e164.slice(3)
    return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
  }
  return e164
}

// Residents cannot self-cancel a Pending Payment booking — that transition is
// owned by the Stripe/expiry flow, not the resident (F3/VER-249). Offering it
// here showed a cancel that silently failed and falsely promised a refund.
// Staff cancel Pending Payment bookings via the admin booking detail.
const CANCELLABLE_STATUSES: BookingStatus[] = ['Submitted', 'Confirmed']
const TERMINAL_STATUSES: BookingStatus[] = [
  'Completed', 'Cancelled', 'Non-conformance', 'Nothing Presented', 'Rebooked', 'Missed Collection',
]

export function BookingDetailClient({ booking, tickets, receiptUrl, ncn, np, paymentSuccess, placeOutHoursBefore, serviceName }: BookingDetailClientProps) {
  const router = useRouter()
  const [isCancelling, setIsCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [isDisputing, setIsDisputing] = useState(false)
  const [isPaying, setIsPaying] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [isPolling, setIsPolling] = useState(paymentSuccess && booking.status === 'Pending Payment')

  // Poll for status change after Stripe redirect
  useEffect(() => {
    if (!isPolling) return
    let attempts = 0
    const maxAttempts = 8
    const supabase = createClient()
    const interval = setInterval(async () => {
      attempts++
      const { data } = await supabase
        .from('booking')
        .select('status')
        .eq('id', booking.id)
        .single()
      if (data && data.status !== 'Pending Payment') {
        clearInterval(interval)
        setIsPolling(false)
        router.refresh()
      } else if (attempts >= maxAttempts) {
        clearInterval(interval)
        setIsPolling(false)
      }
    }, 2500)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handlePayNow() {
    setIsPaying(true)
    setPayError(null)
    try {
      const supabase = createClient()
      const origin = window.location.origin
      const bookingPath = `/booking/${booking.ref}`

      const efResult = await invokeEfWithUserToken<{ checkout_url?: string; already_paid?: boolean }>(
        supabase,
        'create-checkout',
        {
          booking_id: booking.id,
          success_url: `${origin}${bookingPath}?success=true`,
          cancel_url: `${origin}${bookingPath}?cancelled=true`,
        }
      )

      if (!efResult.ok) {
        setPayError(`Failed to create payment session: ${efResult.error}`)
        setIsPaying(false)
        return
      }
      // Already paid (webhook gap) — booking was just reconciled to Confirmed.
      if (efResult.data.already_paid) {
        window.location.href = `${origin}${bookingPath}?success=true`
        return
      }
      if (!efResult.data.checkout_url) {
        setPayError('No checkout URL returned. Please try again.')
        setIsPaying(false)
        return
      }

      window.location.href = efResult.data.checkout_url
    } catch {
      setPayError('An unexpected error occurred. Please try again.')
      setIsPaying(false)
    }
  }

  const collectionDateStr = getCollectionDate(booking)
  const collectionDateObj = collectionDateStr
    ? new Date(collectionDateStr + 'T00:00:00')
    : null
  const daysUntil =
    collectionDateStr !== null
      ? differenceInDays(
          new Date(collectionDateStr + 'T00:00:00'),
          new Date()
        )
      : null
  const showPlaceOut = daysUntil !== null && daysUntil >= 0 && daysUntil <= 3
  const canCancel = CANCELLABLE_STATUSES.includes(booking.status)
  const isTerminal = TERMINAL_STATUSES.includes(booking.status)
  const rebookAddress = booking.property?.formatted_address ?? booking.property?.address ?? null

  const includedItems = booking.booking_item.filter((i) => !i.is_extra)
  const extraItems = booking.booking_item.filter((i) => i.is_extra)

  async function handleCancel() {
    setShowCancelDialog(false)
    setIsCancelling(true)
    setCancelError(null)

    const result = await cancelBooking(booking.id)

    if (!result.ok) {
      setCancelError(result.error)
      setIsCancelling(false)
      return
    }

    router.refresh()
  }

  return (
    <div className="flex flex-col">
      {/* Back link — on the page background, header in a card below
          (matches the tickets/[id] pattern so edges align with content) */}
      <Link
        href="/dashboard"
        className="mb-2.5 flex items-center gap-1.5 text-body-sm font-medium text-[#8FA5B8]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        My Dashboard
      </Link>

      {/* Header card */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-[family-name:var(--font-heading)] text-subtitle font-bold text-[var(--brand)] md:text-lg">
              {booking.ref}
            </h1>
            <p className="mt-0.5 text-body-sm text-gray-500 md:text-sm">
              {booking.property?.formatted_address ?? booking.property?.address ?? '—'}
            </p>
          </div>
          <BookingStatusBadge status={booking.status} />
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-3 pb-24 pt-4 md:pb-8">
        {/* Payment pending banner */}
        {booking.status === 'Pending Payment' && !isPolling && (
          <div className="rounded-[10px] border border-[#8B4000]/30 bg-[#FFF3EA] px-3.5 py-3">
            <div className="mb-0.5 flex items-center gap-1.5 text-body-sm font-semibold text-[#8B4000]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8B4000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              Payment required
            </div>
            <div className="text-xs leading-snug text-[#8B4000]/80">
              This booking is awaiting payment. Complete payment to confirm your collection.
            </div>
          </div>
        )}

        {/* Payment processing banner */}
        {isPolling && (
          <div className="rounded-[10px] border border-[var(--brand-accent-dark)] bg-[var(--brand-accent-light)] px-3.5 py-3">
            <div className="mb-0.5 flex items-center gap-1.5 text-body-sm font-semibold text-[#006A38]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#006A38" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Payment received — confirming your booking...
            </div>
            <div className="text-xs leading-snug text-[#006A38]/80">
              This may take a few moments. The page will refresh automatically.
            </div>
          </div>
        )}

        {/* Place-out reminder — full width */}
        {showPlaceOut && collectionDateStr && (
          <div className="rounded-[10px] border border-[var(--brand-accent-dark)] bg-gradient-to-br from-[var(--brand-accent-light)] to-[#d4f5e6] px-3.5 py-3">
            <div className="mb-0.5 flex items-center gap-1.5 text-body-sm font-semibold text-[var(--brand)]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--brand-accent-dark)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Place out your waste now
            </div>
            <div className="text-xs leading-snug text-gray-700">
              Items must be on the verge by{' '}
              <strong>
                7am {format(collectionDateObj!, 'EEEE d MMMM')}
              </strong>
              . Do not place out more than {formatPlaceOutWindow(placeOutHoursBefore)} before collection.
            </div>
          </div>
        )}

        {/* Row 1: Contact Details (left) + Collection Details (right) */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {/* Contact details */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="mb-2.5 text-2xs font-semibold uppercase tracking-wide text-gray-500">
              Contact Details
            </div>
            {booking.contact ? (
              <div className="flex flex-col">
                <div className="flex items-center justify-between border-b border-gray-100 py-2 text-body-sm">
                  <span className="text-xs text-gray-500">Name</span>
                  <span className="font-medium text-gray-900">{booking.contact.full_name}</span>
                </div>
                <div className="flex items-center justify-between border-b border-gray-100 py-2 text-body-sm">
                  <span className="text-xs text-gray-500">Email</span>
                  <span className="font-medium text-gray-900">{booking.contact.email}</span>
                </div>
                <div className="flex items-center justify-between py-2 text-body-sm">
                  <span className="text-xs text-gray-500">Mobile</span>
                  <span className="font-medium text-gray-900">
                    {booking.contact.mobile_e164 ? formatMobile(booking.contact.mobile_e164) : '—'}
                  </span>
                </div>
              </div>
            ) : (
              <p className="py-2 text-body-sm italic text-gray-400">No contact details available</p>
            )}
          </div>

          {/* Collection details */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="mb-2.5 text-2xs font-semibold uppercase tracking-wide text-gray-500">
              Collection Details
            </div>
            <div className="flex flex-col">
              <div className="flex items-center justify-between border-b border-gray-100 py-2 text-body-sm">
                <span className="text-xs text-gray-500">Date</span>
                <span className="font-medium text-gray-900">
                  {collectionDateObj
                    ? format(collectionDateObj, 'EEEE, d MMMM yyyy')
                    : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-gray-100 py-2 text-body-sm">
                <span className="text-xs text-gray-500">Area</span>
                <span className="font-medium text-gray-900">
                  {(booking.collection_area as { name: string }).name}
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-gray-100 py-2 text-body-sm">
                <span className="text-xs text-gray-500">Location</span>
                <span className="font-medium text-gray-900">
                  {booking.location ?? '—'}
                </span>
              </div>
              <div className="flex items-center justify-between py-2 text-body-sm">
                <span className="text-xs text-gray-500">Notes</span>
                <span className="font-medium text-gray-500 italic">
                  {booking.notes ?? '—'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Row 2: Included Services (left) + Extra Services (right) */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {/* Included services */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="mb-2.5 text-2xs font-semibold uppercase tracking-wide text-gray-500">
              Included Services
            </div>
            <div className="flex flex-col gap-1.5">
              {includedItems.length > 0 ? (
                includedItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between rounded-lg bg-[var(--brand-accent-light)] px-2.5 py-2 text-body-sm"
                  >
                    <span className="text-gray-900">
                      {(item.service as { name: string }).name} &times; {item.no_services}
                    </span>
                    <span className="font-medium text-[#006A38]">Included</span>
                  </div>
                ))
              ) : (
                <p className="py-2 text-body-sm italic text-gray-400">None</p>
              )}
            </div>
          </div>

          {/* Extra services */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="mb-2.5 text-2xs font-semibold uppercase tracking-wide text-gray-500">
              {serviceName ? `${serviceName} Extra` : 'Extra Services'}
            </div>
            <div className="flex flex-col gap-1.5">
              {extraItems.length > 0 ? (
                <>
                  {extraItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-lg bg-[#FFF3EA] px-2.5 py-2 text-body-sm"
                    >
                      <span className="text-gray-900">
                        {(item.service as { name: string }).name} &times; {item.no_services}
                      </span>
                      <span className="font-semibold text-[#8B4000]">
                        ${((item.unit_price_cents * item.no_services) / 100).toFixed(2)} paid
                      </span>
                    </div>
                  ))}
                  {receiptUrl && (
                    <a
                      href={receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 flex items-center gap-1.5 text-[12px] font-medium text-[var(--brand)] hover:underline"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                      </svg>
                      View receipt
                    </a>
                  )}
                </>
              ) : (
                <p className="py-2 text-body-sm italic text-gray-400">None</p>
              )}
            </div>
          </div>
        </div>

        {/* Cancellation cutoff — full width */}
        {canCancel && collectionDateStr && (
          <div className="rounded-[10px] bg-[#E8EEF2] px-3.5 py-3 text-xs text-[var(--brand)]">
            <div className="mb-1 flex items-center gap-1.5 font-semibold">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              Cancellation cutoff
            </div>
            You can cancel this booking until{' '}
            <strong>
              {format(getCutoffDate(collectionDateStr), "h:mmaaa EEEE d MMMM")}
            </strong>
            . After this time the booking is locked.
          </div>
        )}

        {(cancelError || payError) && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
            {cancelError || payError}
          </div>
        )}

        {/* NCN card — shown when booking is Non-conformance or Rebooked */}
        {ncn && (
          <div className="rounded-xl border border-red-100 bg-white p-4 shadow-sm">
            <div className="mb-2.5 flex items-center gap-2">
              <span className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
                Non-Conformance Notice
              </span>
              <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                ncn.status === 'Issued' ? 'bg-gray-100 text-gray-600'
                  : ncn.status === 'Disputed' ? 'bg-red-50 text-red-700'
                  : ncn.status === 'Under Review' ? 'bg-amber-50 text-amber-700'
                  : ncn.status === 'Resolved' ? 'bg-emerald-50 text-emerald-700'
                  : ncn.status === 'Closed' ? 'bg-gray-50 text-gray-400'
                  : 'bg-blue-50 text-blue-700'
              }`}>
                {ncn.status}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-body-sm">
                <span className="text-gray-500">Reason</span>
                <span className="font-medium text-gray-900">{ncn.reason}</span>
              </div>
              <div className="flex items-center justify-between text-body-sm">
                <span className="text-gray-500">Reported</span>
                <span className="font-medium text-gray-900">
                  {format(new Date(ncn.reported_at), 'd MMM yyyy')}
                </span>
              </div>
              {ncn.rescheduled_booking && (
                <div className="flex items-center justify-between text-body-sm">
                  <span className="text-gray-500">Rebooked As</span>
                  <Link
                    href={`/booking/${ncn.rescheduled_booking.ref}`}
                    className="font-semibold text-[var(--brand)] hover:underline"
                  >
                    {ncn.rescheduled_booking.ref} &rarr;
                  </Link>
                </div>
              )}
            </div>
            {ncn.photos.length > 0 && (
              <div className="mt-3 flex gap-2 overflow-x-auto">
                {ncn.photos.map((url, i) => (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="size-16 shrink-0 overflow-hidden rounded-lg bg-gray-100"
                  >
                    <img src={url} alt={`Photo ${i + 1}`} className="size-full object-cover" />
                  </a>
                ))}
              </div>
            )}
            {ncn.status === 'Issued' && (
              <button
                type="button"
                disabled={isDisputing}
                onClick={async () => {
                  setIsDisputing(true)
                  await disputeNcn(ncn.id)
                  router.refresh()
                }}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border-[1.5px] border-[#E53E3E] bg-[#FFF0F0] px-3.5 py-2.5 text-body-sm font-semibold text-[#E53E3E] disabled:opacity-50"
              >
                {isDisputing ? 'Submitting...' : 'Dispute this Notice'}
              </button>
            )}
            {ncn.status === 'Disputed' && (
              <p className="mt-3 text-[12px] text-amber-600">
                Your dispute has been submitted. Our team will review and respond.
              </p>
            )}
          </div>

        )}

        {/* NP card — shown when booking is Nothing Presented or Rebooked */}
        {np && (
          <div className="rounded-xl border border-amber-100 bg-white p-4 shadow-sm">
            <div className="mb-2.5 flex items-center gap-2">
              <span className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
                Nothing Presented
              </span>
              <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                np.status === 'Issued' ? 'bg-gray-100 text-gray-600'
                  : np.status === 'Disputed' ? 'bg-red-50 text-red-700'
                  : np.status === 'Under Review' ? 'bg-blue-50 text-blue-700'
                  : np.status === 'Resolved' ? 'bg-emerald-50 text-emerald-700'
                  : np.status === 'Closed' ? 'bg-gray-50 text-gray-400'
                  : 'bg-purple-50 text-purple-700'
              }`}>
                {np.status}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-body-sm">
                <span className="text-gray-500">Reported</span>
                <span className="font-medium text-gray-900">
                  {format(new Date(np.reported_at), 'd MMM yyyy')}
                </span>
              </div>
              {np.rescheduled_booking && (
                <div className="flex items-center justify-between text-body-sm">
                  <span className="text-gray-500">Rebooked As</span>
                  <Link
                    href={`/booking/${np.rescheduled_booking.ref}`}
                    className="font-semibold text-[var(--brand)] hover:underline"
                  >
                    {np.rescheduled_booking.ref} &rarr;
                  </Link>
                </div>
              )}
            </div>
            {np.photos.length > 0 && (
              <div className="mt-3 flex gap-2 overflow-x-auto">
                {np.photos.map((url, i) => (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="size-16 shrink-0 overflow-hidden rounded-lg bg-gray-100"
                  >
                    <img src={url} alt={`Photo ${i + 1}`} className="size-full object-cover" />
                  </a>
                ))}
              </div>
            )}
            {np.status === 'Issued' && (
              <button
                type="button"
                disabled={isDisputing}
                onClick={async () => {
                  setIsDisputing(true)
                  await disputeNp(np.id)
                  router.refresh()
                }}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border-[1.5px] border-[#E53E3E] bg-[#FFF0F0] px-3.5 py-2.5 text-body-sm font-semibold text-[#E53E3E] disabled:opacity-50"
              >
                {isDisputing ? 'Submitting...' : 'Dispute this Notice'}
              </button>
            )}
            {np.status === 'Disputed' && (
              <p className="mt-3 text-[12px] text-amber-600">
                Your dispute has been submitted. Our team will review and respond.
              </p>
            )}
          </div>
        )}

        {/* Row 3: Enquiries — half width on desktop */}
        {tickets.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2">
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="mb-2.5 flex items-center gap-2">
                <span className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
                  Enquiries
                </span>
                <span className="flex size-5 items-center justify-center rounded-full bg-[#E8EEF2] text-2xs font-bold text-[var(--brand)]">
                  {tickets.length}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {tickets.map((ticket) => {
                  const statusStyle = getStatusStyle('ticket', ticket.status)
                  return (
                    <Link
                      key={ticket.id}
                      href={`/contact/tickets/${ticket.display_id}`}
                      className="block rounded-lg border border-gray-100 px-3 py-2.5 transition-colors hover:border-[var(--brand)]/20 hover:bg-gray-50"
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-mono text-[11px] text-gray-400">
                          {ticket.display_id}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusStyle.bg} ${statusStyle.text}`}
                        >
                          <span className={`size-1.5 rounded-full ${statusStyle.dot}`} />
                          {statusStyle.label}
                        </span>
                      </div>
                      <div className="text-body-sm font-semibold text-[var(--brand)]">
                        {ticket.subject}
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="rounded-full border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500">
                          {CATEGORY_LABELS[ticket.category]}
                        </span>
                        <span className="text-[11px] text-gray-400">
                          {format(new Date(ticket.created_at), 'd MMM yyyy')}
                        </span>
                      </div>
                    </Link>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Action buttons — single row on desktop */}
        <div className="flex flex-col gap-2 md:flex-row md:gap-3">
          {booking.status === 'Pending Payment' && !isPolling && (
            <button
              type="button"
              onClick={handlePayNow}
              disabled={isPaying}
              className="flex items-center justify-center gap-2 rounded-xl border-[1.5px] border-[var(--brand-accent-dark)] bg-[var(--brand-accent-light)] px-3.5 py-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-[#006A38] disabled:opacity-50 md:px-5 md:py-3 md:text-[14px]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                <line x1="1" y1="10" x2="23" y2="10" />
              </svg>
              {isPaying ? 'Redirecting to payment...' : 'Pay Now'}
            </button>
          )}

          <Link
            href={`/contact?booking_ref=${encodeURIComponent(booking.ref)}&booking_id=${encodeURIComponent(booking.id)}`}
            className="flex items-center justify-center gap-2 rounded-xl border-[1.5px] border-[var(--brand)] bg-white px-3.5 py-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-[var(--brand)] md:px-5 md:py-3 md:text-[14px]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {tickets.length > 0 ? 'Raise Enquiry' : 'Get Help'}
          </Link>

          {canCancel && (
            <>
              <Link
                href={booking.property_id && booking.collection_area_id
                  ? `/book/services?${new URLSearchParams({
                      property_id: booking.property_id,
                      collection_area_id: booking.collection_area_id,
                      address: booking.property?.formatted_address ?? booking.property?.address ?? '',
                      items: booking.booking_item
                        .filter((i) => i.no_services > 0)
                        .map((i) => `${i.service_id}:${i.no_services}`)
                        .join(','),
                      total_cents: extraItems.reduce((s, i) => s + i.unit_price_cents * i.no_services, 0).toString(),
                      ...(booking.booking_item[0]?.collection_date_id ? { collection_date_id: booking.booking_item[0].collection_date_id } : {}),
                      ...(booking.location ? { location: booking.location } : {}),
                      ...(booking.notes ? { notes: booking.notes } : {}),
                      return_url: `/booking/${booking.ref}`,
                      // Signals the wizard + create-booking EF to take the
                      // in-place edit branch (update_booking_items_in_place
                      // RPC) instead of creating a new booking. Mirrors the
                      // admin edit flow in admin/bookings/[id]/booking-detail-client.tsx. Without
                      // this, the resident gets a duplicate booking and the
                      // original remains untouched.
                      replaces: booking.id,
                    }).toString()}`
                  : `/book?address=${encodeURIComponent(booking.property?.formatted_address ?? booking.property?.address ?? '')}`
                }
                className="flex items-center justify-center gap-2 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-[var(--brand)] md:px-5 md:py-3 md:text-[14px]"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                Edit Booking
              </Link>
              <button
                type="button"
                onClick={() => setShowCancelDialog(true)}
                disabled={isCancelling}
                className="flex items-center justify-center gap-2 rounded-xl border-[1.5px] border-[#E53E3E] bg-[#FFF0F0] px-3.5 py-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-[#E53E3E] disabled:opacity-50 md:px-5 md:py-3 md:text-[14px]"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                </svg>
                {isCancelling ? 'Cancelling...' : 'Cancel Booking'}
              </button>
            </>
          )}

          {isTerminal && rebookAddress && (
            <Link
              href={`/book?address=${encodeURIComponent(rebookAddress)}`}
              className="flex items-center justify-center gap-2 rounded-xl border-[1.5px] border-[var(--brand-accent-dark)] bg-[var(--brand-accent-light)] px-3.5 py-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-[#006A38] md:px-5 md:py-3 md:text-[14px]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Rebook
            </Link>
          )}
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
              <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)]">
                Cancel this booking?
              </Dialog.Title>
              <p className="mt-1.5 text-body-sm leading-relaxed text-gray-500">
                This action cannot be undone. Any payment will be refunded to the original payment method.
              </p>
              <div className="mt-5 flex gap-2.5">
                <Dialog.Close className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-2.5 font-[family-name:var(--font-heading)] text-sm font-semibold text-[var(--brand)] transition-opacity hover:opacity-90">
                  Keep Booking
                </Dialog.Close>
                <VercoButton
                  variant="destructive"
                  size="sm"
                  type="button"
                  onClick={handleCancel}
                  className="flex-1"
                >
                  Cancel Booking
                </VercoButton>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
