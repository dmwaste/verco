import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { groupStopsIntoRuns, UNASSIGNED_RUN_SEGMENT } from '@/lib/stops/runs'
import { fetchDayStops } from '@/lib/stops/run-sheet-data'
import { STREAM_LABEL } from '@/lib/stops/labels'
import type { WasteStream } from '@/lib/stops/stops'

/**
 * Run picker — the /field index. Crews self-select today's run; a run is
 * derived as (driver_serial, date) from the day's stops, never stored.
 * Also gives the proxy's redirect-to-/field a real page to land on.
 */

export default async function RunPickerPage() {
  const supabase = await createClient()

  const { data: role } = await supabase.rpc('current_user_role')
  if (role === 'ranger') {
    // Rangers don't work runs — their home is the address lookup.
    redirect('/field/lookup')
  }

  const today = awstDateFromUtc(new Date())

  const stops = await fetchDayStops(supabase, today)
  const runs = groupStopsIntoRuns(stops)

  return (
    <div className="flex flex-col gap-3 px-5 pt-4">
      <div className="flex items-center justify-between px-0 py-1">
        <span className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[var(--brand)]">
          Today&apos;s Runs
        </span>
        <span className="text-caption text-gray-500">
          {runs.length} {runs.length === 1 ? 'run' : 'runs'}
        </span>
      </div>

      {runs.map((run) => {
        const driverSegment = run.driverSerial ?? UNASSIGNED_RUN_SEGMENT
        const progressPct = run.total > 0 ? (run.done / run.total) * 100 : 0

        return (
          <Link
            key={driverSegment}
            href={`/field/runs/${today}/${encodeURIComponent(driverSegment)}`}
            className="flex flex-col gap-2.5 rounded-xl bg-white p-4 shadow-sm active:bg-gray-50"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-[family-name:var(--font-heading)] text-base font-bold text-[var(--brand)]">
                  {run.driverSerial ?? 'Unplanned stops'}
                </div>
                <div className="text-xs text-gray-500">
                  {[run.driverName, ...run.clientNames].filter(Boolean).join(' · ')}
                </div>
              </div>
              <span className="rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-caption font-semibold text-[var(--brand)]">
                {run.done}/{run.total}
              </span>
            </div>

            <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-[var(--brand-accent-dark)] transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {(Object.entries(run.streams) as Array<[WasteStream, number]>).map(
                ([stream, count]) => (
                  <span
                    key={stream}
                    className="inline-flex rounded-full bg-gray-50 px-2.5 py-0.5 text-caption font-medium text-gray-700"
                  >
                    {STREAM_LABEL[stream]} {count}
                  </span>
                ),
              )}
              {!run.sequenced && (
                <span className="inline-flex rounded-full bg-[#FFF3EA] px-2.5 py-0.5 text-caption font-semibold text-[#8B4000]">
                  Route not planned yet
                </span>
              )}
            </div>
          </Link>
        )
      })}

      {runs.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-8 text-center shadow-sm">
          <span className="text-sm font-semibold text-[var(--brand)]">
            No runs for today yet
          </span>
          <span className="text-xs text-gray-500">
            Stops appear once a collection date is locked (3 days out).
            Older bookings may still be on the Run Sheet tab.
          </span>
        </div>
      )}
    </div>
  )
}
