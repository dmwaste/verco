'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { VercoButton } from '@/components/ui/verco-button'
import { StreamBadge } from '@/components/field/stream-badge'
import { StopStatusBadge } from '@/components/field/stop-status-badge'
import { getStopMapsUrl, STREAM_LABEL } from '@/lib/stops/labels'
import type { ServiceSummaryEntry, StopStatus, WasteStream } from '@/lib/stops/stops'
import { completeStop } from './actions'
import { StopNcnForm } from './stop-ncn-form'
import { StopNpForm } from './stop-np-form'
import { StopMudForm } from './stop-mud-form'

interface StopBookingItem {
  id: string
  no_services: number
  actual_services: number | null
  is_extra: boolean
  service: { name: string; waste_stream: WasteStream }
}

export interface StopDetail {
  id: string
  stream: WasteStream
  status: StopStatus
  address: string | null
  latitude: number | null
  longitude: number | null
  services_summary: ServiceSummaryEntry[]
  stop_sequence: number | null
  booking: {
    id: string
    ref: string
    status: string
    type: string
    location: string | null
    notes: string | null
    booking_item: StopBookingItem[]
  }
}

interface StopCloseoutClientProps {
  stop: StopDetail
  runHref: string
}

function CloseoutInner({ stop, runHref }: StopCloseoutClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const action = searchParams.get('action')

  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isMud = stop.booking.type === 'MUD'
  const address = stop.address ?? ''
  const mapsUrl = getStopMapsUrl(stop.latitude, stop.longitude, stop.address)

  // Only THIS stream's items close out on this stop — the other pass enters
  // its own counts when its crew works the booking.
  const streamItems = stop.booking.booking_item.filter(
    (i) => i.service.waste_stream === stop.stream,
  )

  const actionable = stop.status === 'Pending' && stop.booking.status === 'Scheduled'

  // Per-stream MUD gate: counts required for this stream's items before ANY
  // closeout path — evaluated BEFORE honouring ?action=ncn/np deep links from
  // the run sheet, or the crew fills a whole NCN form (reason, photos, notes)
  // only to be rejected server-side and lose the lot. ?recount=1 re-opens the
  // form once filled; a requested action is preserved through the save.
  const wantsRecount = searchParams.get('recount') === '1'
  const needsMudCounts =
    isMud &&
    actionable &&
    streamItems.length > 0 &&
    (wantsRecount ||
      streamItems.some((i) => i.actual_services === null || i.actual_services === undefined))

  if (needsMudCounts) {
    const returnTo =
      action === 'ncn' || action === 'np'
        ? `/field/stops/${stop.id}?action=${action}`
        : `/field/stops/${stop.id}`
    return <StopMudForm stop={stop} items={streamItems} returnTo={returnTo} />
  }

  if (action === 'ncn' && actionable) {
    return <StopNcnForm stop={stop} runHref={runHref} />
  }
  if (action === 'np' && actionable) {
    return <StopNpForm stop={stop} runHref={runHref} />
  }

  async function handleComplete() {
    setIsPending(true)
    setError(null)
    try {
      const result = await completeStop(stop.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.push(runHref)
      router.refresh()
    } catch {
      setError('No connection — check signal and retry.')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <>
      {/* Panel header */}
      <div className="shrink-0 border-b border-gray-100 bg-white px-5 py-4">
        <Link
          href={runHref}
          className="mb-2.5 flex items-center gap-1.5 text-body-sm font-medium text-[#8FA5B8]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Run Sheet
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 font-[family-name:var(--font-heading)] text-base font-bold text-[var(--brand)]">
              {stop.booking.ref}
              {stop.stop_sequence !== null && (
                <span className="rounded-md bg-[#E8EEF2] px-1.5 py-0.5 text-[11px] font-bold text-[var(--brand)]">
                  #{stop.stop_sequence}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-body-sm text-gray-500">{address}</div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <StreamBadge stream={stop.stream} />
            {stop.status !== 'Pending' && <StopStatusBadge status={stop.status} />}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 pb-24 pt-4">
        {/* Stop details — NO PII */}
        <div className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm">
          <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
            {STREAM_LABEL[stop.stream]} Pass
            {isMud && ' · MUD'}
          </div>
          <div className="flex justify-between border-b border-gray-100 py-1 text-body-sm">
            <span className="text-xs text-gray-500">Location</span>
            <span className="font-medium text-gray-900">{stop.booking.location ?? '—'}</span>
          </div>
          <div className="flex justify-between border-b border-gray-100 py-1 text-body-sm">
            <span className="text-xs text-gray-500">Services</span>
            <span className="font-medium text-gray-900">
              {stop.services_summary.map((s) => `${s.name} × ${s.qty}`).join(', ')}
            </span>
          </div>
          <div className="flex justify-between py-1 text-body-sm">
            <span className="text-xs text-gray-500">Notes</span>
            <span className="font-medium italic text-gray-500">
              {stop.booking.notes ?? '—'}
            </span>
          </div>
        </div>

        {/* Maps link */}
        {mapsUrl && (
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
        )}

        {/* MUD counts confirmation banner — only when all stream counts saved */}
        {isMud && actionable && streamItems.length > 0 && (
          <div className="rounded-[10px] border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-[12px] text-emerald-800">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Counts saved</span>
              <Link
                href={`/field/stops/${stop.id}?recount=1`}
                className="-m-3 inline-block p-3 text-[11px] font-medium text-emerald-700 underline"
              >
                Edit counts
              </Link>
            </div>
            <div className="mt-1 space-y-0.5">
              {streamItems.map((i) => (
                <div key={i.id} className="flex justify-between text-[11px]">
                  <span>{i.service.name}</span>
                  <span className="font-mono">{i.actual_services ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Close out actions — this stream only */}
        {actionable && (
          <div className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm">
            <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
              Close Out — {STREAM_LABEL[stop.stream]}
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
                  href={`/field/stops/${stop.id}?action=ncn`}
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
                  href={`/field/stops/${stop.id}?action=np`}
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

        {!actionable && stop.status === 'Pending' && (
          <div className="rounded-lg bg-[#FFF3EA] px-3.5 py-2.5 text-xs text-[#8B4000]">
            This booking is &quot;{stop.booking.status}&quot; — stops can only be
            closed out once it&apos;s Scheduled (the day of collection).
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
            <span>{error}</span>
            <button
              type="button"
              onClick={handleComplete}
              className="shrink-0 rounded-md bg-white px-2.5 py-1 text-[11px] font-semibold text-red-700 shadow-sm"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </>
  )
}

export function StopCloseoutClient(props: StopCloseoutClientProps) {
  return (
    <Suspense>
      <CloseoutInner {...props} />
    </Suspense>
  )
}
