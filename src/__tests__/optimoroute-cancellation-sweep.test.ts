/**
 * sweepCancelledOrders — deletes the OptimoRoute orders behind Cancelled
 * stops. Runs hourly (sync-optimoroute-cancellations) and once more right
 * before the 8pm route share (send-routes-to-optimoroute, ADR 0028).
 *
 * Deno-only module loaded through a runtime-only import path (tsc never
 * follows it). The Supabase client is a minimal fake of the two query shapes
 * the sweep issues; fetch is stubbed at the routing-API boundary.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

type SweepResult = { candidates: number; deleted: number; failed: number }
type Sweep = (supabase: unknown, today: string) => Promise<SweepResult>

const SWEEP_MODULE = '../../supabase/functions/_shared/optimoroute-cancellations.ts'

let sweepCancelledOrders: Sweep

beforeAll(async () => {
  ;({ sweepCancelledOrders } = (await import(/* @vite-ignore */ SWEEP_MODULE)) as {
    sweepCancelledOrders: Sweep
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

interface FakeDb {
  client: unknown
  filters: Array<[string, ...unknown[]]>
  stamped: string[][]
}

function fakeDb(rows: Array<{ id: string; external_order_ref: string }>, fetchError?: string): FakeDb {
  const db: FakeDb = { client: null, filters: [], stamped: [] }
  const select = {
    eq: (...a: unknown[]) => (db.filters.push(['eq', ...a]), select),
    is: (...a: unknown[]) => (db.filters.push(['is', ...a]), select),
    gte: (...a: unknown[]) => (db.filters.push(['gte', ...a]), select),
    order: () => select,
    range: async (from: number, to: number) =>
      fetchError
        ? { data: null, error: { message: fetchError } }
        : { data: rows.slice(from, to + 1), error: null },
  }
  db.client = {
    from: () => ({
      select: () => select,
      update: () => ({
        in: async (_col: string, ids: string[]) => {
          db.stamped.push(ids)
          return { error: null }
        },
      }),
    }),
  }
  return db
}

function stubRoutingApi(perOrder: Array<{ success: boolean; code?: string }>) {
  vi.stubGlobal('Deno', { env: { get: (k: string) => (k === 'OPTIMOROUTE_API_KEY' ? 'k3y' : undefined) } })
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ success: true, orders: perOrder }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('sweepCancelledOrders', () => {
  it('only looks at un-swept Cancelled stops dated today or later', async () => {
    const db = fakeDb([])

    await sweepCancelledOrders(db.client, '2026-10-12')

    expect(db.filters).toEqual([
      ['eq', 'status', 'Cancelled'],
      ['is', 'external_deleted_at', null],
      ['gte', 'collection_date.date', '2026-10-12'],
    ])
  })

  it('does nothing — and needs no routing key — when nothing is cancelled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const db = fakeDb([])

    await expect(sweepCancelledOrders(db.client, '2026-10-12')).resolves.toEqual({
      candidates: 0,
      deleted: 0,
      failed: 0,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.stamped).toEqual([])
  })

  it('stamps deleted and already-gone orders, and counts rejections as failed', async () => {
    const fetchMock = stubRoutingApi([
      { success: true },
      { success: false, code: 'ERR_ORD_NOT_FOUND' },
      { success: false, code: 'ERR_OPT_RUNNING' },
    ])
    const db = fakeDb([
      { id: 'stop-1', external_order_ref: 'MOS-12984-B' },
      { id: 'stop-2', external_order_ref: 'MOS-2DJSO1-G' },
      { id: 'stop-3', external_order_ref: 'KWN-1-8ZVAL2-B' },
    ])

    await expect(sweepCancelledOrders(db.client, '2026-10-12')).resolves.toEqual({
      candidates: 3,
      deleted: 2,
      failed: 1,
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.optimoroute.com/v1/delete_orders?key=k3y')
    expect(JSON.parse(init.body as string)).toEqual({
      orders: [{ orderNo: 'MOS-12984-B' }, { orderNo: 'MOS-2DJSO1-G' }, { orderNo: 'KWN-1-8ZVAL2-B' }],
    })
    // The rejected order stays un-stamped so the next sweep retries it.
    expect(db.stamped).toEqual([['stop-1', 'stop-2']])
  })

  it('pages past the 1000-row cap and deletes in 500-order batches', async () => {
    vi.stubGlobal('Deno', { env: { get: () => 'k3y' } })
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const { orders } = JSON.parse(init!.body as string) as { orders: unknown[] }
      return new Response(
        JSON.stringify({ success: true, orders: orders.map(() => ({ success: true })) }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      id: `stop-${i}`,
      external_order_ref: `MOS-${i}-B`,
    }))
    const db = fakeDb(rows)

    await expect(sweepCancelledOrders(db.client, '2026-10-12')).resolves.toEqual({
      candidates: 1001,
      deleted: 1001,
      failed: 0,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(db.stamped[0]).toHaveLength(1001)
  })

  it('throws when the cancelled-stops read fails', async () => {
    const db = fakeDb([], 'statement timeout')

    await expect(sweepCancelledOrders(db.client, '2026-10-12')).rejects.toThrow(
      'cancelled stops fetch: statement timeout',
    )
  })
})
