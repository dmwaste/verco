import { describe, expect, it } from 'vitest'
import {
  groupStopsIntoRuns,
  runStatus,
  UNASSIGNED_RUN_SEGMENT,
  type PickerStop,
} from '@/lib/stops/runs'
import type { StopStatus, WasteStream } from '@/lib/stops/stops'

let seq = 0
const stop = (
  overrides: Partial<PickerStop> & { driver_serial: string | null },
): PickerStop => ({
  id: `stop-${++seq}`,
  stream: 'general' as WasteStream,
  status: 'Pending' as StopStatus,
  driver_name: null,
  stop_sequence: null,
  client_name: 'City of Kwinana',
  ...overrides,
})

describe('groupStopsIntoRuns', () => {
  it('groups stops by driver serial and counts per stream', () => {
    const runs = groupStopsIntoRuns([
      stop({ driver_serial: 'KWN1', stream: 'general' }),
      stop({ driver_serial: 'KWN1', stream: 'general' }),
      stop({ driver_serial: 'KWN1', stream: 'green' }),
      stop({ driver_serial: 'KWNA', stream: 'ancillary' }),
    ])
    expect(runs).toHaveLength(2)
    expect(runs[0]!.driverSerial).toBe('KWN1')
    expect(runs[0]!.total).toBe(3)
    expect(runs[0]!.streams).toEqual({ general: 2, green: 1 })
    expect(runs[1]!.driverSerial).toBe('KWNA')
    expect(runs[1]!.streams).toEqual({ ancillary: 1 })
  })

  it('counts terminal stops as done; Pending is not done', () => {
    const runs = groupStopsIntoRuns([
      stop({ driver_serial: 'VV1', status: 'Completed' }),
      stop({ driver_serial: 'VV1', status: 'Non-conformance' }),
      stop({ driver_serial: 'VV1', status: 'Nothing Presented' }),
      stop({ driver_serial: 'VV1', status: 'Pending' }),
    ])
    expect(runs[0]!.done).toBe(3)
    expect(runs[0]!.total).toBe(4)
    // NCN + NP count as exceptions; Completed and Pending do not.
    expect(runs[0]!.exceptions).toBe(2)
  })

  it('excludes cancelled stops entirely — an all-cancelled run disappears', () => {
    const runs = groupStopsIntoRuns([
      stop({ driver_serial: 'VV1', status: 'Cancelled' }),
      stop({ driver_serial: 'VV2', status: 'Pending' }),
      stop({ driver_serial: 'VV2', status: 'Cancelled' }),
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.driverSerial).toBe('VV2')
    expect(runs[0]!.total).toBe(1)
  })

  it('buckets driverless stops as the unplanned run, sorted last', () => {
    const runs = groupStopsIntoRuns([
      stop({ driver_serial: null }),
      stop({ driver_serial: 'KWN1' }),
      stop({ driver_serial: null }),
    ])
    expect(runs.map((r) => r.driverSerial)).toEqual(['KWN1', null])
    expect(runs[1]!.total).toBe(2)
  })

  it('flags sequenced when any live stop has a routing sequence', () => {
    const unplanned = groupStopsIntoRuns([stop({ driver_serial: 'KWN1' })])
    expect(unplanned[0]!.sequenced).toBe(false)

    const planned = groupStopsIntoRuns([
      stop({ driver_serial: 'KWN1' }),
      stop({ driver_serial: 'KWN1', stop_sequence: 4 }),
    ])
    expect(planned[0]!.sequenced).toBe(true)
  })

  it('collects distinct client names sorted, and backfills driver name', () => {
    const runs = groupStopsIntoRuns([
      stop({ driver_serial: 'VV1', client_name: 'WMRC' }),
      stop({ driver_serial: 'VV1', client_name: 'City of Kwinana', driver_name: 'VV Crew 1' }),
      stop({ driver_serial: 'VV1', client_name: 'WMRC' }),
    ])
    expect(runs[0]!.clientNames).toEqual(['City of Kwinana', 'WMRC'])
    expect(runs[0]!.driverName).toBe('VV Crew 1')
  })

  it('sorts named runs alphabetically by serial', () => {
    const runs = groupStopsIntoRuns([
      stop({ driver_serial: 'VV2' }),
      stop({ driver_serial: 'KWNA' }),
      stop({ driver_serial: 'VV1' }),
    ])
    expect(runs.map((r) => r.driverSerial)).toEqual(['KWNA', 'VV1', 'VV2'])
  })

  it('returns empty for no stops', () => {
    expect(groupStopsIntoRuns([])).toEqual([])
  })

  it('exports the unassigned URL segment used by the picker and run sheet', () => {
    expect(UNASSIGNED_RUN_SEGMENT).toBe('unassigned')
  })
})

describe('runStatus', () => {
  it('is Not started when nothing is done', () => {
    expect(runStatus({ total: 4, done: 0, exceptions: 0 })).toBe('Not started')
  })

  it('is In progress when some but not all stops are done', () => {
    expect(runStatus({ total: 4, done: 2, exceptions: 0 })).toBe('In progress')
  })

  it('is Complete when every stop is done and clean', () => {
    expect(runStatus({ total: 4, done: 4, exceptions: 0 })).toBe('Complete')
  })

  it('is Has exceptions whenever a stop is NCN/NP — even a fully-worked run', () => {
    expect(runStatus({ total: 4, done: 2, exceptions: 1 })).toBe('Has exceptions')
    expect(runStatus({ total: 4, done: 4, exceptions: 1 })).toBe('Has exceptions')
  })
})
