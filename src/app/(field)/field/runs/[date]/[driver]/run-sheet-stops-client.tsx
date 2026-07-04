'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { StreamBadge } from '@/components/field/stream-badge'
import { StopStatusBadge } from '@/components/field/stop-status-badge'
import { getStopMapsUrl, splitAddress, formatTime } from '@/lib/stops/labels'
import type { StopStatus } from '@/lib/stops/stops'
import type { RunStop, RunMeta } from '@/lib/stops/run-sheet-data'
import { completeStop } from '../../../stops/[id]/actions'
import { useRefreshOnFocus } from './use-refresh-on-focus'

interface RunSheetStopsClientProps {
  date: string
  driverSerial: string | null
  stops: RunStop[]
  runMeta: RunMeta | null
}

const TERMINAL: StopStatus[] = ['Completed', 'Non-conformance', 'Nothing Presented']

interface StopCardProps {
  stop: RunStop
  error: string | undefined
  isPending: boolean
  onComplete: (stop: RunStop) => void
}

function StopCard({ stop, error, isPending, onComplete }: StopCardProps) {
  const { street, suburb } = splitAddress(stop.address)
  const mapsUrl = getStopMapsUrl(stop.latitude, stop.longitude, stop.address)
  const isMud = stop.booking.type === 'MUD'
  const actionable = stop.status === 'Pending' && stop.booking.status === 'Scheduled'
  const eta = stop.scheduled_at?.match(/^(\d{2}:\d{2})/)?.[1] ?? null

  return (
    <div
      className={`flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm ${
        stop.status !== 'Pending' ? 'opacity-70' : ''
      }`}
    >
      <Link
        href={`/field/stops/${stop.id}`}
        className="flex items-start gap-3 active:opacity-80"
      >
        {/* Sequence chip — the crew's collection number for this pass */}
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--brand)] font-[family-name:var(--font-heading)] text-sm font-bold text-[var(--brand-accent)]">
          {stop.stop_sequence ?? '—'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-[family-name:var(--font-heading)] text-xs font-semibold text-[#8FA5B8]">
              {stop.booking.ref}
              {isMud && ' · MUD'}
            </span>
            {eta && <span className="text-caption text-gray-400">~{eta}</span>}
          </div>
          <div className="text-sm font-semibold leading-snug text-[var(--brand)]">
            {street}
          </div>
          {suburb && <div className="text-xs text-gray-500">{suburb}</div>}
        </div>
        {stop.status === 'Pending' ? (
          <StreamBadge stream={stop.stream} />
        ) : (
          <StopStatusBadge status={stop.status} />
        )}
      </Link>

      <div className="flex flex-wrap gap-1.5">
        {stop.status !== 'Pending' && <StreamBadge stream={stop.stream} />}
        {stop.services_summary.map((s) => (
          <span
            key={s.name}
            className="inline-flex rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-caption font-medium text-[var(--brand)]"
          >
            {s.name} &times; {s.qty}
          </span>
        ))}
      </div>

      {(stop.waste_location || stop.driver_notes) && (
        <div className="flex flex-col gap-1 text-xs">
          {stop.waste_location && (
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 font-semibold text-[var(--brand)]">Location:</span>
              <span className="min-w-0 break-words text-gray-600">{stop.waste_location}</span>
            </div>
          )}
          {stop.driver_notes && (
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 font-semibold text-[var(--brand)]">Notes:</span>
              <span className="min-w-0 break-words text-gray-600">{stop.driver_notes}</span>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => onComplete(stop)}
            className="shrink-0 rounded-md bg-white px-3 py-2.5 text-caption font-semibold text-red-700 shadow-sm"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-gray-100 pt-1.5">
        {mapsUrl ? (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-[44px] items-center gap-1 text-caption font-medium text-[var(--brand-accent-dark)]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            Maps
          </a>
        ) : (
          <span />
        )}

        {actionable && (
          <div className="flex gap-1.5">
            <Link
              href={`/field/stops/${stop.id}?action=ncn`}
              className="flex min-h-[44px] items-center rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 text-xs font-semibold text-gray-700"
            >
              NCN
            </Link>
            <Link
              href={`/field/stops/${stop.id}?action=np`}
              className="flex min-h-[44px] items-center rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 text-xs font-semibold text-gray-700"
            >
              NP
            </Link>
            {isMud ? (
              <Link
                href={`/field/stops/${stop.id}`}
                className="flex min-h-[44px] items-center rounded-lg bg-[var(--brand)] px-3 text-xs font-semibold"
                style={{ color: 'var(--brand-foreground, #FFFFFF)' }}
              >
                Enter Count
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => onComplete(stop)}
                disabled={isPending}
                className="flex min-h-[44px] items-center rounded-lg bg-[var(--brand)] px-3 text-xs font-semibold disabled:opacity-50"
                style={{ color: 'var(--brand-foreground, #FFFFFF)' }}
              >
                {isPending ? 'Saving…' : 'Done ✓'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function RunSheetStopsClient({
  date,
  driverSerial,
  stops,
  runMeta,
}: RunSheetStopsClientProps) {
  const router = useRouter()
  useRefreshOnFocus()

  // Per-stop pending set: a single pendingId would re-enable an in-flight
  // card the moment a second card is tapped, opening double-submits.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  const live = stops.filter((s) => s.status !== 'Cancelled')
  const remaining = live.filter((s) => s.status === 'Pending')
  const done = live.filter((s) => TERMINAL.includes(s.status))
  const cancelled = stops.filter((s) => s.status === 'Cancelled')
  const progressPct = live.length > 0 ? (done.length / live.length) * 100 : 0

  const sequenced = remaining.filter((s) => s.stop_sequence !== null)
  const unsequenced = remaining.filter((s) => s.stop_sequence === null)

  const startTime = formatTime(runMeta?.startTime ?? null)
  const finishTime = formatTime(runMeta?.finishTime ?? null)

  async function handleComplete(stop: RunStop) {
    if (pendingIds.has(stop.id)) return
    setPendingIds((prev) => new Set(prev).add(stop.id))
    setErrors((prev) => ({ ...prev, [stop.id]: '' }))
    try {
      const result = await completeStop(stop.id)
      if (!result.ok) {
        setErrors((prev) => ({ ...prev, [stop.id]: result.error }))
        return
      }
      router.refresh()
    } catch {
      setErrors((prev) => ({
        ...prev,
        [stop.id]: 'No connection — check signal and retry.',
      }))
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev)
        next.delete(stop.id)
        return next
      })
    }
  }

  return (
    <div className="flex flex-col gap-3 px-5 pt-4">
      {/* Sticky run header */}
      <div className="sticky top-0 z-10 -mx-5 border-b border-gray-100 bg-gray-50/95 px-5 pb-3 pt-1 backdrop-blur">
        <div className="flex items-center justify-between">
          <Link
            href="/field"
            className="flex items-center gap-1.5 text-body-sm font-medium text-[#8FA5B8]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Runs
          </Link>
          <span className="text-caption text-gray-500">
            {format(parseISO(date), 'EEE d MMM')}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <div>
            <span className="font-[family-name:var(--font-heading)] text-base font-bold text-[var(--brand)]">
              {driverSerial ?? 'Unplanned stops'}
            </span>
            {runMeta?.driverName && (
              <span className="ml-2 text-xs text-gray-500">{runMeta.driverName}</span>
            )}
          </div>
          <span className="rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-caption font-semibold text-[var(--brand)]">
            {done.length}/{live.length}
          </span>
        </div>
        {(startTime || finishTime || (runMeta?.depotLabels.length ?? 0) > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-gray-500">
            {startTime && finishTime && (
              <span>
                {startTime} – {finishTime}
              </span>
            )}
            {runMeta?.depotLabels.map((label) => (
              <span key={label} className="inline-flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                </svg>
                {label}
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full bg-[var(--brand-accent-dark)] transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {sequenced.map((stop) => (
        <StopCard
          key={stop.id}
          stop={stop}
          error={errors[stop.id] || undefined}
          isPending={pendingIds.has(stop.id)}
          onComplete={handleComplete}
        />
      ))}

      {unsequenced.length > 0 && (
        <>
          <div className="rounded-lg bg-[#FFF3EA] px-3.5 py-2 text-xs text-[#8B4000]">
            {sequenced.length > 0
              ? 'These stops have no route sequence yet — work them in any order.'
              : 'Route not planned yet — stops are listed unordered.'}
          </div>
          {unsequenced.map((stop) => (
            <StopCard
              key={stop.id}
              stop={stop}
              error={errors[stop.id] || undefined}
              isPending={pendingIds.has(stop.id)}
              onComplete={handleComplete}
            />
          ))}
        </>
      )}

      {done.length > 0 && (
        <>
          <div className="mt-1 flex items-center justify-between px-0 py-1">
            <span className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[var(--brand)]">
              Done
            </span>
            <span className="text-caption text-gray-500">{done.length} stops</span>
          </div>
          {done.map((stop) => (
            <StopCard
              key={stop.id}
              stop={stop}
              error={undefined}
              isPending={false}
              onComplete={handleComplete}
            />
          ))}
        </>
      )}

      {cancelled.length > 0 && (
        <>
          <div className="mt-1 flex items-center justify-between px-0 py-1">
            <span className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-gray-400">
              Cancelled
            </span>
            <span className="text-caption text-gray-400">{cancelled.length} stops</span>
          </div>
          {cancelled.map((stop) => {
            const { street, suburb } = splitAddress(stop.address)
            return (
              <div
                key={stop.id}
                className="flex items-center justify-between rounded-xl bg-white p-3.5 opacity-50 shadow-sm"
              >
                <div>
                  <div className="text-xs font-semibold text-[#8FA5B8]">
                    {stop.booking.ref}
                  </div>
                  <div className="text-sm font-medium text-gray-500 line-through">
                    {street}
                    {suburb && `, ${suburb}`}
                  </div>
                </div>
                <StreamBadge stream={stop.stream} />
              </div>
            )
          })}
        </>
      )}

      {stops.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-8 text-center shadow-sm">
          <span className="text-sm font-semibold text-[var(--brand)]">
            No stops on this run
          </span>
          <span className="text-xs text-gray-500">
            Head back to Runs and pick another.
          </span>
        </div>
      )}
    </div>
  )
}
