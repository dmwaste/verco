import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { UNASSIGNED_RUN_SEGMENT } from '@/lib/stops/runs'
import { fetchRunStops, fetchRunMeta, isValidRunDate } from '@/lib/stops/run-sheet-data'
import { RunSheetStopsClient } from './run-sheet-stops-client'

interface RunSheetPageProps {
  params: Promise<{ date: string; driver: string }>
}

/**
 * Sequenced run sheet for one (driver, date) run. Stops are denormalised
 * (address/lat/lng/services on the stop row) so this page never joins
 * booking → contacts — structural PII exclusion for field crews. The stop /
 * run-meta reads live in `@/lib/stops/run-sheet-data` (shared with the admin
 * run sheets) so the two surfaces can't drift on select list or ordering.
 */
export default async function RunSheetByDriverPage({ params }: RunSheetPageProps) {
  const { date, driver: rawDriver } = await params

  if (!isValidRunDate(date)) {
    redirect('/field')
  }
  const driver = decodeURIComponent(rawDriver)
  const isUnassigned = driver === UNASSIGNED_RUN_SEGMENT

  const supabase = await createClient()
  const [stops, runMeta] = await Promise.all([
    fetchRunStops(supabase, date, driver),
    fetchRunMeta(supabase, date, driver),
  ])

  return (
    <RunSheetStopsClient
      date={date}
      driverSerial={isUnassigned ? null : driver}
      stops={stops}
      runMeta={runMeta}
    />
  )
}
