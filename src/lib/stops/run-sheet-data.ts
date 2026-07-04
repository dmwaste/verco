import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { UNASSIGNED_RUN_SEGMENT, type PickerStop } from '@/lib/stops/runs'
import type { Database } from '@/lib/supabase/types'
import type { ServiceSummaryEntry, StopStatus, WasteStream } from '@/lib/stops/stops'

/**
 * Shared run-sheet reads — the single source of truth for the stop/run-meta
 * queries behind BOTH the field run sheet (`/field`, `/field/runs/[date]/[driver]`)
 * and the admin run sheets (`/admin/run-sheets`). Extracted so the two surfaces
 * can never drift on the select list, ordering, or pagination. Type-only
 * imports keep this module free of server-only runtime, so client components
 * may import `RunStop` from here.
 *
 * Contractor-wide by design: callers filter by date only and let
 * `collection_stop` RLS bound the result to the caller's clients (a run spans
 * councils). Do NOT add a getCurrentAdminClient() filter here.
 */

type Client = SupabaseClient<Database>

/** One stop on a run-sheet detail (denormalised — never joins to contacts). */
export interface RunStop {
  id: string
  stream: WasteStream
  status: StopStatus
  address: string | null
  latitude: number | null
  longitude: number | null
  services_summary: ServiceSummaryEntry[]
  waste_location: string | null
  driver_notes: string | null
  stop_sequence: number | null
  scheduled_at: string | null
  driver_serial: string | null
  driver_name: string | null
  booking: { id: string; ref: string; status: string; type: string }
}

/** Run header context pulled from the routing engine (start/finish + depots). */
export interface RunMeta {
  driverName: string | null
  startTime: string | null
  finishTime: string | null
  depotLabels: string[]
}

interface DayStopRow {
  id: string
  stream: WasteStream
  status: StopStatus
  driver_serial: string | null
  driver_name: string | null
  stop_sequence: number | null
  client: { name: string } | null
}

/** `YYYY-MM-DD` route-param guard — pages redirect on a miss (target differs). */
export function isValidRunDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
}

/**
 * Every stop for a date, mapped to the run-picker shape. Paginates past the
 * PostgREST 1000-row cap — a busy day across drivers/councils exceeds one page.
 */
export async function fetchDayStops(supabase: Client, date: string): Promise<PickerStop[]> {
  const rows = await fetchAllRows<DayStopRow>((from, to) =>
    supabase
      .from('collection_stop')
      .select(
        `id, stream, status, driver_serial, driver_name, stop_sequence,
         client:client_id(name),
         collection_date!inner(date)`,
      )
      .eq('collection_date.date', date)
      .order('id')
      .range(from, to) as unknown as PromiseLike<{
      data: DayStopRow[] | null
      error: { message: string } | null
    }>,
  )

  return rows.map((row) => ({
    id: row.id,
    stream: row.stream,
    status: row.status,
    driver_serial: row.driver_serial,
    driver_name: row.driver_name,
    stop_sequence: row.stop_sequence,
    client_name: row.client?.name ?? '',
  }))
}

/**
 * All stops for one run `(date, driver)`, sequenced first. `driver` is the raw
 * `driver_serial` or `UNASSIGNED_RUN_SEGMENT` for the unplanned bucket (the
 * entire day's driverless stops — the dataset most likely to exceed one page).
 */
export async function fetchRunStops(
  supabase: Client,
  date: string,
  driver: string,
): Promise<RunStop[]> {
  const isUnassigned = driver === UNASSIGNED_RUN_SEGMENT

  return fetchAllRows<RunStop>((from, to) => {
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
}

/**
 * Run header (route start/finish + depot labels) for one `(date, driver)`.
 * Null for the unplanned bucket — it has no planned route.
 */
export async function fetchRunMeta(
  supabase: Client,
  date: string,
  driver: string,
): Promise<RunMeta | null> {
  if (driver === UNASSIGNED_RUN_SEGMENT) return null

  const { data } = await supabase
    .from('collection_run_meta')
    .select('driver_name, start_time, finish_time, depot_labels')
    .eq('driver_serial', driver)
    .eq('date', date)
    .maybeSingle()

  if (!data) return null
  return {
    driverName: data.driver_name,
    startTime: data.start_time,
    finishTime: data.finish_time,
    depotLabels: (data.depot_labels as string[] | null) ?? [],
  }
}
