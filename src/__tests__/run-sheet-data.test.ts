import { describe, expect, it } from 'vitest'
import {
  fetchDayStops,
  fetchRunStops,
  fetchRunMeta,
  isValidRunDate,
} from '@/lib/stops/run-sheet-data'

/**
 * Characterisation of the shared run-sheet fetch contract. The field run sheet
 * and the admin run sheets both go through these helpers, so a change to the
 * select list, ordering, filters, or the unassigned-bucket handling that would
 * silently alter what crews / ops see fails HERE. Uses a recording fake for the
 * chainable PostgREST builder — no live DB.
 */

interface RecordedCalls {
  table: string
  select: string
  filters: Array<[string, string, unknown]>
  orders: Array<[string, unknown]>
  ranges: Array<[number, number]>
  maybeSingle: boolean
}

function makeFake(rows: unknown[]) {
  const calls: RecordedCalls = {
    table: '',
    select: '',
    filters: [],
    orders: [],
    ranges: [],
    maybeSingle: false,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {
    select(cols: string) {
      calls.select = cols
      return builder
    },
    eq(col: string, val: unknown) {
      calls.filters.push(['eq', col, val])
      return builder
    },
    is(col: string, val: unknown) {
      calls.filters.push(['is', col, val])
      return builder
    },
    order(col: string, opts?: unknown) {
      calls.orders.push([col, opts])
      return builder
    },
    range(from: number, to: number) {
      calls.ranges.push([from, to])
      return builder
    },
    maybeSingle() {
      calls.maybeSingle = true
      return Promise.resolve({ data: rows[0] ?? null, error: null })
    },
    then(res: (v: { data: unknown[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(res, rej)
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      calls.table = table
      return builder
    },
  }
  return { client: client as Parameters<typeof fetchDayStops>[0], calls }
}

describe('isValidRunDate', () => {
  it('accepts YYYY-MM-DD and rejects anything else', () => {
    expect(isValidRunDate('2026-07-08')).toBe(true)
    expect(isValidRunDate('2026-7-8')).toBe(false)
    expect(isValidRunDate('08-07-2026')).toBe(false)
    expect(isValidRunDate("2026-07-08'; drop")).toBe(false)
  })
})

describe('fetchDayStops', () => {
  it('queries collection_stop by date with the picker select + id order', async () => {
    const { client, calls } = makeFake([
      {
        id: 's1',
        stream: 'general',
        status: 'Pending',
        driver_serial: 'KWN1',
        driver_name: 'A',
        stop_sequence: 1,
        client: { name: 'City of Kwinana' },
      },
    ])
    const stops = await fetchDayStops(client, '2026-07-08')

    expect(calls.table).toBe('collection_stop')
    expect(calls.select).toContain('client:client_id(name)')
    expect(calls.select).toContain('collection_date!inner(date)')
    expect(calls.filters).toContainEqual(['eq', 'collection_date.date', '2026-07-08'])
    expect(calls.orders).toContainEqual(['id', undefined])
    // No client-id filter — contractor-wide, RLS bounds the tenancy.
    expect(calls.filters.some(([, col]) => col === 'client_id')).toBe(false)

    expect(stops[0]).toEqual({
      id: 's1',
      stream: 'general',
      status: 'Pending',
      driver_serial: 'KWN1',
      driver_name: 'A',
      stop_sequence: 1,
      client_name: 'City of Kwinana',
    })
  })

  it('maps a null client embed to an empty client_name', async () => {
    const { client } = makeFake([
      {
        id: 's1',
        stream: 'general',
        status: 'Pending',
        driver_serial: null,
        driver_name: null,
        stop_sequence: null,
        client: null,
      },
    ])
    const stops = await fetchDayStops(client, '2026-07-08')
    expect(stops[0]!.client_name).toBe('')
  })
})

describe('fetchRunStops', () => {
  it('filters by driver_serial and orders sequence-first (nulls last), then id', async () => {
    const { client, calls } = makeFake([])
    await fetchRunStops(client, '2026-07-08', 'KWN1')

    expect(calls.filters).toContainEqual(['eq', 'collection_date.date', '2026-07-08'])
    expect(calls.filters).toContainEqual(['eq', 'driver_serial', 'KWN1'])
    expect(calls.orders[0]).toEqual(['stop_sequence', { ascending: true, nullsFirst: false }])
    expect(calls.orders).toContainEqual(['id', undefined])
    expect(calls.select).toContain('booking:booking_id(id, ref, status, type)')
  })

  it('uses .is(driver_serial, null) for the unassigned bucket, never .eq', async () => {
    const { client, calls } = makeFake([])
    await fetchRunStops(client, '2026-07-08', 'unassigned')

    expect(calls.filters).toContainEqual(['is', 'driver_serial', null])
    expect(calls.filters).not.toContainEqual(['eq', 'driver_serial', 'unassigned'])
  })
})

describe('fetchRunMeta', () => {
  it('reads collection_run_meta by (driver_serial, date) and maps to camelCase', async () => {
    const { client, calls } = makeFake([
      { driver_name: 'A', start_time: '06:00:00', finish_time: '10:00:00', depot_labels: ['Depot'] },
    ])
    const meta = await fetchRunMeta(client, '2026-07-08', 'KWN1')

    expect(calls.table).toBe('collection_run_meta')
    expect(calls.maybeSingle).toBe(true)
    expect(meta).toEqual({
      driverName: 'A',
      startTime: '06:00:00',
      finishTime: '10:00:00',
      depotLabels: ['Depot'],
    })
  })

  it('returns null for the unassigned bucket without querying', async () => {
    const { client, calls } = makeFake([])
    const meta = await fetchRunMeta(client, '2026-07-08', 'unassigned')
    expect(meta).toBeNull()
    expect(calls.table).toBe('')
  })

  it('returns null when no run-meta row exists (pushed, not yet pulled)', async () => {
    const { client } = makeFake([])
    const meta = await fetchRunMeta(client, '2026-07-08', 'KWN1')
    expect(meta).toBeNull()
  })
})
