'use client'

import { format, parseISO } from 'date-fns'
import { DetailHeader } from '@/components/admin/detail-header'
import { Th } from '@/components/admin/th'
import { StatusBadge } from '@/components/status-badge'
import { StopStatusBadge } from '@/components/field/stop-status-badge'
import { getStopMapsUrl } from '@/lib/stops/labels'
import {
  runStatus,
  TERMINAL_STOP_STATUSES,
  EXCEPTION_STOP_STATUSES,
} from '@/lib/stops/runs'
import type { RunStop, RunMeta } from '@/lib/stops/run-sheet-data'

interface RunSheetDetailClientProps {
  date: string
  driverSerial: string | null
  stops: RunStop[]
  runMeta: RunMeta | null
}

/** 'HH:MM:SS' (Postgres time) → 'h:mma'. Time-of-day only, so TZ-agnostic. */
function formatTime(time: string | null): string | null {
  const match = time?.match(/^(\d{2}):(\d{2})/)
  if (!match) return null
  const d = new Date()
  d.setHours(Number(match[1]), Number(match[2]), 0, 0)
  return format(d, 'h:mmaaa')
}

function splitAddress(address: string | null): { street: string; suburb: string } {
  const full = address ?? ''
  const parts = full.split(',')
  return { street: parts[0]?.trim() ?? full, suburb: parts.slice(1).join(',').trim() || '' }
}

export function RunSheetDetailClient({
  date,
  driverSerial,
  stops,
  runMeta,
}: RunSheetDetailClientProps) {
  const live = stops.filter((s) => s.status !== 'Cancelled')
  const cancelled = stops.filter((s) => s.status === 'Cancelled')
  const done = live.filter((s) => TERMINAL_STOP_STATUSES.has(s.status)).length
  const exceptions = live.filter((s) => EXCEPTION_STOP_STATUSES.has(s.status)).length
  const pct = live.length > 0 ? Math.round((done / live.length) * 100) : 0
  const status = runStatus({ total: live.length, done, exceptions })

  const startTime = formatTime(runMeta?.startTime ?? null)
  const finishTime = formatTime(runMeta?.finishTime ?? null)
  const someUnsequenced = live.some((s) => s.stop_sequence === null)
  const weekday = format(parseISO(date), 'EEEE d MMMM yyyy')

  return (
    <>
      <DetailHeader
        backHref={`/admin/run-sheets?date=${date}`}
        backLabel="Run Sheets"
        title={driverSerial ?? 'Unassigned'}
        subtitle={weekday}
      >
        <StatusBadge entity="run" status={status} />
        <button
          type="button"
          onClick={() => window.print()}
          aria-label="Print run sheet"
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#293F52] px-3.5 py-2 text-body-sm font-semibold text-white hover:bg-[#1f2f3d] print:hidden"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </svg>
          Print
        </button>
      </DetailHeader>

      <div className="flex-1 px-7 pb-6 pt-5">
        {/* Run summary strip — doubles as the printed sheet's header line */}
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm text-gray-600">
          <span className="font-medium text-[#293F52]">{done} of {live.length} done</span>
          {exceptions > 0 && (
            <span className="text-status-error">{exceptions} exception{exceptions === 1 ? '' : 's'}</span>
          )}
          {startTime && finishTime && <span>{startTime} – {finishTime}</span>}
          {(runMeta?.depotLabels ?? []).map((label) => (
            <span key={label} className="text-gray-500">{label}</span>
          ))}
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-gray-100 print:hidden">
            <div className="h-full rounded-full bg-[#293F52]" style={{ width: `${pct}%` }} />
          </div>
        </div>

        {someUnsequenced && (
          <p className="mb-2 text-body-sm text-status-warn print:hidden">
            Some stops have no route sequence yet — the route hasn&apos;t been fully planned.
          </p>
        )}

        <div className="overflow-x-auto rounded-xl bg-white shadow-sm print:overflow-visible print:rounded-none print:shadow-none">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th className="w-12">#</Th>
                <Th>Address</Th>
                <Th>Services</Th>
                <Th>Notes</Th>
                <Th className="print:hidden">Status</Th>
                <th scope="col" className="hidden w-16 border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-caption font-semibold uppercase tracking-wide text-gray-500 print:table-cell">
                  Done
                </th>
              </tr>
            </thead>
            <tbody>
              {live.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-gray-400">
                    No stops on this run.
                  </td>
                </tr>
              )}
              {live.map((stop) => {
                const { street, suburb } = splitAddress(stop.address)
                const mapsUrl = getStopMapsUrl(stop.latitude, stop.longitude, stop.address)
                const services = stop.services_summary.map((s) => `${s.name} ×${s.qty}`).join(', ')
                return (
                  <tr
                    key={stop.id}
                    className="border-b border-gray-100 last:border-b-0 align-top hover:bg-gray-50 print:break-inside-avoid print:hover:bg-transparent"
                  >
                    <td className="px-4 py-3 font-medium text-[#293F52]">{stop.stop_sequence ?? '—'}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#293F52]">{street}</div>
                      {suburb && <div className="text-body-sm text-gray-500">{suburb}</div>}
                      <div className="text-caption text-gray-400">
                        {stop.booking.ref}
                        {stop.booking.type === 'MUD' && ' · MUD'}
                      </div>
                      {mapsUrl && (
                        <a
                          href={mapsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-caption font-medium text-status-info hover:underline print:hidden"
                        >
                          Maps
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-3 text-body-sm text-gray-600">{services || '—'}</td>
                    <td className="px-4 py-3 text-body-sm text-gray-600">
                      {stop.waste_location && <div>{stop.waste_location}</div>}
                      {stop.driver_notes && <div className="text-gray-500">{stop.driver_notes}</div>}
                      {!stop.waste_location && !stop.driver_notes && '—'}
                    </td>
                    <td className="px-4 py-3 print:hidden">
                      <StopStatusBadge status={stop.status} />
                    </td>
                    <td className="hidden px-4 py-3 print:table-cell">
                      <span className="inline-block size-4 rounded-[3px] border border-gray-500" />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {cancelled.length > 0 && (
          <div className="mt-6 print:hidden">
            <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-gray-400">
              Cancelled ({cancelled.length})
            </div>
            <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
              <table className="w-full border-collapse">
                <tbody>
                  {cancelled.map((stop) => {
                    const { street, suburb } = splitAddress(stop.address)
                    return (
                      <tr key={stop.id} className="border-b border-gray-100 opacity-60 last:border-b-0">
                        <td className="px-4 py-2.5 text-body-sm text-gray-500 line-through">
                          {street}{suburb && `, ${suburb}`}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <StopStatusBadge status={stop.status} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Printed-sheet footer — the only branded mark; page numbers come from
            the browser print chrome. */}
        <div className="mt-6 hidden items-center justify-between border-t border-gray-300 pt-2 text-caption text-gray-500 print:flex">
          <span className="font-semibold text-[#293F52]">D&amp;M Waste Management</span>
          <span>Run sheet · {weekday}</span>
        </div>
      </div>
    </>
  )
}
