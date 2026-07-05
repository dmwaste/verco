'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { addDays, format, formatDistanceToNow, parseISO, subDays } from 'date-fns'
import { PageHeader } from '@/components/admin/page-header'
import { Th } from '@/components/admin/th'
import { StatusBadge, Pill } from '@/components/status-badge'
import { RefreshRoutesButton } from '@/components/admin/refresh-routes-button'
import { runStatus, UNASSIGNED_RUN_SEGMENT, type RunSummary } from '@/lib/stops/runs'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { STREAM_LABEL } from '@/lib/stops/labels'
import type { WasteStream } from '@/lib/stops/stops'

interface RunSheetsListClientProps {
  date: string
  runs: RunSummary[]
  lastSyncedAt: string | null
}

export function RunSheetsListClient({ date, runs, lastSyncedAt }: RunSheetsListClientProps) {
  const router = useRouter()

  function goto(next: string) {
    router.push(`/admin/run-sheets?date=${next}`)
  }

  const parsed = parseISO(date)
  const prevDate = format(subDays(parsed, 1), 'yyyy-MM-dd')
  const nextDate = format(addDays(parsed, 1), 'yyyy-MM-dd')
  const todayDate = awstDateFromUtc(new Date())
  const isToday = date === todayDate

  return (
    <>
      <PageHeader
        title="Run Sheets"
        subtitle={`${runs.length} ${runs.length === 1 ? 'run' : 'runs'} · ${format(parsed, 'EEEE d MMMM yyyy')}`}
      >
        {lastSyncedAt && (
          <span className="hidden text-xs text-gray-400 lg:inline">
            Synced {formatDistanceToNow(parseISO(lastSyncedAt), { addSuffix: true })}
          </span>
        )}
        <RefreshRoutesButton />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => goto(prevDate)}
            aria-label="Previous day"
            className="inline-flex size-9 items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && goto(e.target.value)}
            aria-label="Pick a date"
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-body-sm text-[#293F52]"
          />
          <button
            type="button"
            onClick={() => goto(nextDate)}
            aria-label="Next day"
            className="inline-flex size-9 items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => goto(todayDate)}
            disabled={isToday}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-body-sm font-medium text-[#293F52] hover:bg-gray-50 disabled:opacity-40"
          >
            Today
          </button>
        </div>
      </PageHeader>

      <div className="flex-1 px-7 pb-6 pt-5">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th>Driver</Th>
                <Th>Councils</Th>
                <Th>Streams</Th>
                <Th>Progress</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center">
                    <div className="text-sm font-medium text-gray-500">No runs for this date</div>
                    <div className="mt-1 text-body-sm text-gray-400">
                      Stops are generated at T-3, once routes are pushed to OptimoRoute.
                    </div>
                  </td>
                </tr>
              )}
              {runs.map((run) => {
                const segment = run.driverSerial ?? UNASSIGNED_RUN_SEGMENT
                const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0
                const status = runStatus(run)
                return (
                  <tr key={segment} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/run-sheets/${date}/${encodeURIComponent(segment)}`}
                        className="font-medium text-[#293F52] hover:underline"
                      >
                        {run.driverSerial ?? 'Unassigned'}
                      </Link>
                      {run.driverName && (
                        <div className="text-body-sm text-gray-500">{run.driverName}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-body-sm text-gray-600">
                      {run.clientNames.length > 0 ? run.clientNames.join(', ') : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(Object.entries(run.streams) as Array<[WasteStream, number]>).map(
                          ([stream, count]) => (
                            <Pill key={stream} tone="neutral">
                              {STREAM_LABEL[stream]} {count}
                            </Pill>
                          ),
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-body-sm font-medium text-gray-600">
                          {run.done}/{run.total}
                        </span>
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-gray-100">
                          <div className="h-full rounded-full bg-[#293F52]" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge entity="run" status={status} />
                        {!run.sequenced && <Pill tone="warn">Not planned</Pill>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
