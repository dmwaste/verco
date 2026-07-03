import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { UNASSIGNED_RUN_SEGMENT } from '@/lib/stops/runs'
import { RunSheetStopsClient, type RunStop } from './run-sheet-stops-client'

interface RunSheetPageProps {
  params: Promise<{ date: string; driver: string }>
}

/**
 * Sequenced run sheet for one (driver, date) run. Stops are denormalised
 * (address/lat/lng/services on the stop row) so this page never joins
 * booking → contacts — structural PII exclusion for field crews.
 */
export default async function RunSheetByDriverPage({ params }: RunSheetPageProps) {
  const { date, driver: rawDriver } = await params

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    redirect('/field')
  }
  const driver = decodeURIComponent(rawDriver)
  const isUnassigned = driver === UNASSIGNED_RUN_SEGMENT

  const supabase = await createClient()

  // Paginated past max_rows: the unassigned bucket is the entire day's
  // unplanned stops — exactly the dataset that can exceed one page.
  const stops = await fetchAllRows<RunStop>((from, to) => {
    const query = supabase
      .from('collection_stop')
      .select(
        `id, stream, status, address, latitude, longitude, services_summary,
         waste_location, driver_notes,
         stop_sequence, scheduled_at, driver_serial, driver_name,
         booking:booking_id(id, ref, status, type),
         collection_date!inner(date)`,
      )
      .eq('collection_date.date', date)
      .order('stop_sequence', { ascending: true, nullsFirst: false })
      .order('id')
      .range(from, to)
    return (isUnassigned
      ? query.is('driver_serial', null)
      : query.eq('driver_serial', driver)) as unknown as PromiseLike<{
      data: RunStop[] | null
      error: { message: string } | null
    }>
  })

  // Run-sheet header metadata (route start/finish + depot labels) pulled
  // from the routing engine. RLS: contractor roles only — exactly who works
  // runs. Unplanned buckets have no route, so no meta.
  const { data: runMeta } = isUnassigned
    ? { data: null }
    : await supabase
        .from('collection_run_meta')
        .select('driver_name, start_time, finish_time, depot_labels')
        .eq('driver_serial', driver)
        .eq('date', date)
        .maybeSingle()

  return (
    <RunSheetStopsClient
      date={date}
      driverSerial={isUnassigned ? null : driver}
      stops={stops}
      runMeta={
        runMeta
          ? {
              driverName: runMeta.driver_name,
              startTime: runMeta.start_time,
              finishTime: runMeta.finish_time,
              depotLabels: (runMeta.depot_labels as string[] | null) ?? [],
            }
          : null
      }
    />
  )
}
