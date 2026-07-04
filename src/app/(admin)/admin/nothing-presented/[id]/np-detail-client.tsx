'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Dialog } from '@base-ui/react/dialog'
import { updateNpStatus, rebookNp, resolveNpWithRefund } from './actions'
import { StatusBadge, Pill } from '@/components/status-badge'
import type { Database } from '@/lib/supabase/types'
import type { ResolvedAuditEntry } from '@/lib/audit/resolve'
import { AuditTimeline } from '@/components/audit-timeline'
import { DetailHeader } from '@/components/admin/detail-header'

type NpStatus = Database['public']['Enums']['np_status']

interface BookingItem {
  id: string
  no_services: number
  is_extra: boolean
  unit_price_cents: number
  service: { name: string }
}

interface Np {
  id: string
  status: NpStatus
  contractor_fault: boolean
  notes: string | null
  photos: string[]
  reported_at: string
  resolved_at: string | null
  resolution_notes: string | null
  rescheduled_date: string | null
  booking: {
    id: string
    ref: string
    status: string
    type: string
    location: string | null
    property: { formatted_address: string | null; address: string } | null
    collection_area: { id: string; name: string; code: string }
    contact: { full_name: string; email: string; mobile_e164: string | null } | null
    booking_item: BookingItem[]
  } | null
  reporter: { display_name: string | null } | null
  resolver: { display_name: string | null } | null
  rescheduled_booking: { id: string; ref: string } | null
}

interface NpDetailClientProps {
  np: Np
  availableDates: { id: string; date: string }[]
  auditLogs: ResolvedAuditEntry[]
}

export function NpDetailClient({ np, availableDates, auditLogs }: NpDetailClientProps) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolutionNotes, setResolutionNotes] = useState(np.resolution_notes ?? '')
  const [contractorFault, setDmFault] = useState(np.contractor_fault)
  const [showRebookDialog, setShowRebookDialog] = useState(false)
  const [showRefundDialog, setShowRefundDialog] = useState(false)
  const [selectedDateId, setSelectedDateId] = useState('')
  const [lightboxPhoto, setLightboxPhoto] = useState<string | null>(null)

  const booking = np.booking as Np['booking']
  const address = booking?.property?.formatted_address ?? booking?.property?.address ?? '—'
  const status = np.status as string
  const isActionable = status === 'Disputed' || status === 'Under Review'
  const isIssued = status === 'Issued'

  const paidItems = booking?.booking_item.filter((i) => i.is_extra) ?? []
  const paidAmountCents = paidItems.reduce((sum, i) => sum + i.unit_price_cents * i.no_services, 0)
  const hasPaidItems = paidAmountCents > 0

  async function handleStatusUpdate(newStatus: 'Under Review' | 'Resolved') {
    if (newStatus === 'Resolved' && contractorFault && hasPaidItems) {
      setShowRefundDialog(true)
      return
    }

    setIsSubmitting(true)
    setError(null)
    const result = await updateNpStatus(np.id, newStatus, resolutionNotes, contractorFault)
    if (!result.ok) {
      setError(result.error)
      setIsSubmitting(false)
      return
    }
    router.refresh()
  }

  async function handleResolveWithRefund() {
    setShowRefundDialog(false)
    setIsSubmitting(true)
    setError(null)
    const result = await resolveNpWithRefund(np.id, resolutionNotes)
    if (!result.ok) {
      setError(result.error)
      setIsSubmitting(false)
      return
    }
    router.refresh()
  }

  async function handleRebook() {
    if (!selectedDateId) return
    setShowRebookDialog(false)
    setIsSubmitting(true)
    setError(null)
    const result = await rebookNp(np.id, selectedDateId, resolutionNotes, contractorFault)
    if (!result.ok) {
      setError(result.error)
      setIsSubmitting(false)
      return
    }
    router.refresh()
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <DetailHeader
        backHref="/admin/nothing-presented"
        backLabel="Nothing Presented"
        title={`NP — ${booking?.ref ?? 'Unknown'}`}
        subtitle={address}
      >
        <Pill tone={np.contractor_fault ? 'error' : 'neutral'}>
          {np.contractor_fault ? 'Contractor Fault' : 'Resident Fault'}
        </Pill>
        <StatusBadge entity="np" status={np.status} />
      </DetailHeader>

      {/* Content */}
      <div className="flex-1 px-7 py-5">
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
            {error}
          </div>
        )}

        {/* Info cards */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* NP info */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">
              Nothing Presented Details
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between text-body-sm">
                <span className="text-gray-500">Fault Type</span>
                <Pill tone={np.contractor_fault ? 'error' : 'neutral'}>
                  {np.contractor_fault ? 'Contractor' : 'Resident'}
                </Pill>
              </div>
              <div className="flex items-center justify-between text-body-sm">
                <span className="text-gray-500">Reported</span>
                <span className="font-medium text-gray-900">
                  {format(new Date(np.reported_at), 'd MMM yyyy, h:mmaaa')}
                </span>
              </div>
              <div className="flex items-center justify-between text-body-sm">
                <span className="text-gray-500">Reported By</span>
                <span className="font-medium text-gray-900">
                  {(np.reporter as { display_name: string | null } | null)?.display_name ?? '—'}
                </span>
              </div>
              {np.notes && (
                <div className="text-body-sm">
                  <span className="text-gray-500">Field Notes</span>
                  <p className="mt-1 rounded-lg bg-gray-50 px-3 py-2 text-gray-700">{np.notes}</p>
                </div>
              )}
              {np.resolved_at && (
                <>
                  <div className="flex items-center justify-between text-body-sm">
                    <span className="text-gray-500">Resolved</span>
                    <span className="font-medium text-gray-900">
                      {format(new Date(np.resolved_at), 'd MMM yyyy, h:mmaaa')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-body-sm">
                    <span className="text-gray-500">Resolved By</span>
                    <span className="font-medium text-gray-900">
                      {(np.resolver as { display_name: string | null } | null)?.display_name ?? '—'}
                    </span>
                  </div>
                </>
              )}
              {np.rescheduled_booking && (
                <div className="flex items-center justify-between text-body-sm">
                  <span className="text-gray-500">Rebooked As</span>
                  <Link
                    href={`/admin/bookings/${(np.rescheduled_booking as { id: string }).id}`}
                    className="font-semibold text-[#293F52] hover:underline"
                  >
                    {(np.rescheduled_booking as { ref: string }).ref}
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* Booking info */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">
              Booking Details
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between text-body-sm">
                <span className="text-gray-500">Reference</span>
                {booking ? (
                  <Link href={`/admin/bookings/${booking.id}`} className="font-semibold text-[#293F52] hover:underline">
                    {booking.ref}
                  </Link>
                ) : '—'}
              </div>
              <div className="flex items-center justify-between text-body-sm">
                <span className="text-gray-500">Area</span>
                <span className="font-medium text-gray-900">{booking?.collection_area.name ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between text-body-sm">
                <span className="text-gray-500">Type</span>
                <span className="font-medium text-gray-900">{booking?.type ?? '—'}</span>
              </div>
              {booking?.contact && (
                <>
                  <div className="flex items-center justify-between text-body-sm">
                    <span className="text-gray-500">Contact</span>
                    <span className="font-medium text-gray-900">{booking.contact.full_name}</span>
                  </div>
                  <div className="flex items-center justify-between text-body-sm">
                    <span className="text-gray-500">Email</span>
                    <span className="font-medium text-gray-900">{booking.contact.email}</span>
                  </div>
                </>
              )}
              <div className="mt-1 text-caption font-semibold uppercase tracking-wide text-gray-500">
                Services
              </div>
              {booking?.booking_item.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-body-sm ${
                    item.is_extra ? 'bg-[#FFF3EA]' : 'bg-[#E8FDF0]'
                  }`}
                >
                  <span className="text-gray-900">
                    {(item.service as { name: string }).name} &times; {item.no_services}
                  </span>
                  <span className={item.is_extra ? 'font-semibold text-[#8B4000]' : 'font-medium text-[#006A38]'}>
                    {item.is_extra
                      ? `$${((item.unit_price_cents * item.no_services) / 100).toFixed(2)}`
                      : 'Included'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Photos */}
        {np.photos.length > 0 && (
          <div className="mt-4 rounded-xl bg-white p-5 shadow-sm">
            <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">
              Photos ({np.photos.length})
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {np.photos.map((url, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setLightboxPhoto(url)}
                  className="aspect-square overflow-hidden rounded-lg bg-gray-100"
                >
                  <img
                    src={url}
                    alt={`NP photo ${i + 1}`}
                    className="size-full object-cover transition-transform hover:scale-105"
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Resolution section */}
        {isActionable && (
          <div className="mt-4 rounded-xl bg-white p-5 shadow-sm">
            <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">
              Resolution
            </div>

            <label className="mb-3 flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={contractorFault}
                onChange={(e) => setDmFault(e.target.checked)}
                className="size-4 rounded border-gray-300 text-[#293F52] focus:ring-[#293F52]"
              />
              <span className="text-body-sm font-medium text-gray-900">Contractor fault</span>
              <span className="text-caption text-gray-400">
                — allocations restored, paid items refunded if not rebooked
              </span>
            </label>

            <textarea
              value={resolutionNotes}
              onChange={(e) => setResolutionNotes(e.target.value)}
              placeholder="Resolution notes (internal only)..."
              rows={3}
              className="mb-4 w-full rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-2.5 text-body-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[#293F52]"
            />

            <div className="flex flex-wrap gap-2.5">
              {status === 'Disputed' && (
                <button
                  type="button"
                  onClick={() => handleStatusUpdate('Under Review')}
                  disabled={isSubmitting}
                  className="rounded-lg border-[1.5px] border-blue-200 bg-blue-50 px-4 py-2.5 text-body-sm font-semibold text-blue-700 disabled:opacity-50"
                >
                  Mark Under Review
                </button>
              )}
              <button
                type="button"
                onClick={() => handleStatusUpdate('Resolved')}
                disabled={isSubmitting}
                className="rounded-lg border-[1.5px] border-emerald-200 bg-emerald-50 px-4 py-2.5 text-body-sm font-semibold text-emerald-700 disabled:opacity-50"
              >
                {isSubmitting ? 'Saving...' : 'Resolve'}
              </button>
              <button
                type="button"
                onClick={() => setShowRebookDialog(true)}
                disabled={isSubmitting || availableDates.length === 0}
                className="rounded-lg border-[1.5px] border-purple-200 bg-purple-50 px-4 py-2.5 text-body-sm font-semibold text-purple-700 disabled:opacity-50"
              >
                Rebook
              </button>
            </div>
          </div>
        )}

        {/* Issued — awaiting resident response */}
        {isIssued && (
          <div className="mt-4 rounded-xl border border-gray-100 bg-gray-50 p-5">
            <div className="flex items-center gap-2 text-body-sm font-medium text-gray-500">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Awaiting resident response — no action required
            </div>
            <p className="mt-1.5 text-xs text-gray-400">
              The resident has 14 days to dispute this notice. If undisputed, it will auto-close.
            </p>
          </div>
        )}

        {/* Resolved resolution notes (read-only) */}
        {!isActionable && !isIssued && np.resolution_notes && (
          <div className="mt-4 rounded-xl bg-white p-5 shadow-sm">
            <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">
              Resolution Notes
            </div>
            <p className="rounded-lg bg-gray-50 px-3 py-2.5 text-body-sm text-gray-700">
              {np.resolution_notes}
            </p>
          </div>
        )}

        {/* Audit trail */}
        {auditLogs.length > 0 && (
          <div className="mt-4 rounded-xl bg-white shadow-sm">
            <AuditTimeline entries={auditLogs} />
          </div>
        )}
      </div>

      {/* Rebook dialog */}
      <Dialog.Root open={showRebookDialog} onOpenChange={setShowRebookDialog}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
              <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
                Rebook Collection
              </Dialog.Title>
              <p className="mt-1.5 text-body-sm text-gray-500">
                Select a new collection date for {address}.
              </p>
              <select
                value={selectedDateId}
                onChange={(e) => setSelectedDateId(e.target.value)}
                className="mt-4 w-full rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-2.5 text-body-sm text-gray-900"
              >
                <option value="">Select a date...</option>
                {availableDates.map((d) => (
                  <option key={d.id} value={d.id}>
                    {format(new Date(d.date + 'T00:00:00'), 'EEEE d MMMM yyyy')}
                  </option>
                ))}
              </select>
              <div className="mt-5 flex gap-2.5">
                <Dialog.Close className="flex-1 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
                  Cancel
                </Dialog.Close>
                <button
                  type="button"
                  onClick={handleRebook}
                  disabled={!selectedDateId || isSubmitting}
                  className="flex-1 rounded-xl bg-[#293F52] px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-white disabled:opacity-50"
                >
                  {isSubmitting ? 'Rebooking...' : 'Confirm Rebook'}
                </button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Refund confirmation dialog */}
      <Dialog.Root open={showRefundDialog} onOpenChange={setShowRefundDialog}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
              <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-status-warn-bg">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
                Resolve with Refund
              </Dialog.Title>
              <p className="mt-1.5 text-body-sm leading-relaxed text-gray-500">
                This booking has <strong>${(paidAmountCents / 100).toFixed(2)}</strong> in paid services.
                A refund will be issued automatically because Contractor fault is selected.
              </p>
              <div className="mt-5 flex gap-2.5">
                <Dialog.Close className="flex-1 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
                  Cancel
                </Dialog.Close>
                <button
                  type="button"
                  onClick={handleResolveWithRefund}
                  disabled={isSubmitting}
                  className="flex-1 rounded-xl bg-amber-500 px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-white disabled:opacity-50"
                >
                  {isSubmitting ? 'Processing...' : 'Resolve & Refund'}
                </button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Photo lightbox */}
      <Dialog.Root open={!!lightboxPhoto} onOpenChange={() => setLightboxPhoto(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/80" />
          <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <button
              type="button"
              onClick={() => setLightboxPhoto(null)}
              className="absolute right-4 top-4 z-50 flex size-8 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            {lightboxPhoto && (
              <img
                src={lightboxPhoto}
                alt="NP photo"
                className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain"
              />
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
