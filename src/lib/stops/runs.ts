import type { StopStatus, WasteStream } from './stops'

/**
 * Run-picker aggregation: a "run" is derived as (driver_serial, date) from
 * the day's stops — never stored (engine-agnostic; no user↔driver mapping).
 * Stops the routing pull hasn't assigned to a driver yet group under a
 * single unplanned bucket (driverSerial: null) so crews are never stranded
 * when ops plan late.
 */

export const UNASSIGNED_RUN_SEGMENT = 'unassigned'

export const TERMINAL_STOP_STATUSES: ReadonlySet<StopStatus> = new Set([
  'Completed',
  'Non-conformance',
  'Nothing Presented',
])

export interface PickerStop {
  id: string
  stream: WasteStream
  status: StopStatus
  driver_serial: string | null
  driver_name: string | null
  stop_sequence: number | null
  client_name: string
}

export interface RunSummary {
  /** null = unplanned bucket (no driver assigned by the routing pull yet) */
  driverSerial: string | null
  driverName: string | null
  /** Distinct client names across the run's stops, sorted. */
  clientNames: string[]
  /** Live (non-cancelled) stop count. */
  total: number
  /** Terminal (Completed / NCN / NP) stop count. */
  done: number
  /** Live stop count per stream, insertion-ordered by stream key. */
  streams: Partial<Record<WasteStream, number>>
  /** True when at least one live stop carries a routing sequence. */
  sequenced: boolean
}

/**
 * Groups a day's stops into run summaries. Cancelled stops are excluded
 * entirely — a run whose stops were all cancelled disappears from the
 * picker. Named runs sort alphabetically by driver serial; the unplanned
 * bucket always sorts last.
 */
export function groupStopsIntoRuns(stops: PickerStop[]): RunSummary[] {
  const byDriver = new Map<string | null, RunSummary>()

  for (const stop of stops) {
    if (stop.status === 'Cancelled') continue

    const key = stop.driver_serial
    let run = byDriver.get(key)
    if (!run) {
      run = {
        driverSerial: key,
        driverName: stop.driver_name,
        clientNames: [],
        total: 0,
        done: 0,
        streams: {},
        sequenced: false,
      }
      byDriver.set(key, run)
    }

    run.total += 1
    if (TERMINAL_STOP_STATUSES.has(stop.status)) run.done += 1
    run.streams[stop.stream] = (run.streams[stop.stream] ?? 0) + 1
    if (stop.stop_sequence !== null) run.sequenced = true
    if (!run.driverName && stop.driver_name) run.driverName = stop.driver_name
    if (stop.client_name && !run.clientNames.includes(stop.client_name)) {
      run.clientNames.push(stop.client_name)
    }
  }

  const runs = [...byDriver.values()]
  for (const run of runs) run.clientNames.sort()

  return runs.sort((a, b) => {
    if (a.driverSerial === null) return 1
    if (b.driverSerial === null) return -1
    return a.driverSerial.localeCompare(b.driverSerial)
  })
}
