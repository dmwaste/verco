import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPushRejectionAlert,
  DUPLICATE_ORDER_NO_CODE,
  isDuplicateOrderNoError,
  MASS_REJECTION_MIN,
  newPushRejections,
  NO_PIN_PUSH_ERROR,
  PUSH_ALERT_MAX_LISTED,
  pushRunOutcome,
  type PushFailure,
  type PushRejection,
} from '@/lib/stops/stops'

// ADR 0041: an order OptimoRoute refuses on its own is that order's outcome,
// not a failed run. SOP-VHPDL0-G (a duplicate orderNo inside OR) made every
// hourly push 500 from 24/10 to 27/10/2026 — ~80 Sentry errors for one stop.

const DUPLICATE = 'Multiple orders with the matching orderNo were found.'

const failure = (id: string, error: string, level: PushFailure['level'] = 'order'): PushFailure => ({
  id,
  orderRef: `REF-${id}`,
  error,
  level,
})

describe('pushRunOutcome — sync_log status + HTTP status for a push run', () => {
  it('a clean run is success / 200', () => {
    expect(pushRunOutcome({ runErrors: 0, rejected: 0, pushed: 130 })).toEqual({ status: 'success', http: 200 })
    expect(pushRunOutcome({ runErrors: 0, rejected: 0, pushed: 0 })).toEqual({ status: 'success', http: 200 })
  })

  it('one refused order is partial / 207 — never a 500, even when it was the only order in the run', () => {
    // 60+ of the 24–27/10 runs pushed nothing but the one duplicate.
    expect(pushRunOutcome({ runErrors: 0, rejected: 1, pushed: 0 })).toEqual({ status: 'partial', http: 207 })
    expect(pushRunOutcome({ runErrors: 0, rejected: 1, pushed: 130 })).toEqual({ status: 'partial', http: 207 })
  })

  it('any run-level failure is failed / 500, refused orders or not', () => {
    expect(pushRunOutcome({ runErrors: 1, rejected: 0, pushed: 0 })).toEqual({ status: 'failed', http: 500 })
    expect(pushRunOutcome({ runErrors: 1, rejected: 3, pushed: 50 })).toEqual({ status: 'failed', http: 500 })
  })

  it('a mass refusal with nothing pushed reads as an outage, not bad orders', () => {
    expect(pushRunOutcome({ runErrors: 0, rejected: MASS_REJECTION_MIN, pushed: 0 })).toEqual({
      status: 'failed',
      http: 500,
    })
    expect(pushRunOutcome({ runErrors: 0, rejected: MASS_REJECTION_MIN - 1, pushed: 0 })).toEqual({
      status: 'partial',
      http: 207,
    })
    // Something got through, so OR is up: still per-order.
    expect(pushRunOutcome({ runErrors: 0, rejected: MASS_REJECTION_MIN, pushed: 1 })).toEqual({
      status: 'partial',
      http: 207,
    })
  })
})

describe('newPushRejections — name a refused order once per error', () => {
  it('names a stop the first time it is refused', () => {
    const fresh = failure('s1', DUPLICATE)
    expect(newPushRejections([fresh], new Map([['s1', null]]))).toEqual([fresh])
  })

  it('stays quiet while the stop keeps the same error (the hourly retry)', () => {
    expect(newPushRejections([failure('s1', DUPLICATE)], new Map([['s1', DUPLICATE]]))).toEqual([])
  })

  it('names the stop again when its error changes', () => {
    const changed = failure('s1', NO_PIN_PUSH_ERROR)
    expect(newPushRejections([changed], new Map([['s1', DUPLICATE]]))).toEqual([changed])
  })

  it('ignores request-level failures: an outage is the 500, not one card per stop', () => {
    expect(newPushRejections([failure('s1', 'HTTP 502: Bad Gateway', 'request')], new Map([['s1', null]]))).toEqual(
      [],
    )
  })

  it('treats a stop missing from the map as new', () => {
    expect(newPushRejections([failure('s9', DUPLICATE)], new Map())).toHaveLength(1)
  })
})

describe('isDuplicateOrderNoError', () => {
  it('matches on the OR code or the message text', () => {
    expect(isDuplicateOrderNoError({ error: 'anything', code: DUPLICATE_ORDER_NO_CODE })).toBe(true)
    expect(isDuplicateOrderNoError({ error: DUPLICATE })).toBe(true)
    expect(isDuplicateOrderNoError({ error: NO_PIN_PUSH_ERROR })).toBe(false)
  })
})

describe('buildPushRejectionAlert — the ops card', () => {
  const rejection = (orderRef: string, error = DUPLICATE, date = '2026-10-27'): PushRejection => ({
    orderRef,
    date,
    error,
  })

  it('returns null with nothing new to say', () => {
    expect(buildPushRejectionAlert([])).toBeNull()
  })

  it('names the stop, its collection date and the error, and spells out the duplicate-orderNo fix', () => {
    const alert = buildPushRejectionAlert([rejection('SOP-TEST01-G')])!
    expect(alert.title).toBe('⚠️ OptimoRoute refused order SOP-TEST01-G')
    expect(alert.lines).toContain(`• SOP-TEST01-G, collection 27/10/2026: ${DUPLICATE}`)
    const text = alert.lines.join('\n')
    expect(text).toMatch(/Delete the extra copy in OptimoRoute/)
    expect(text).toMatch(/Verco never deletes OptimoRoute orders/)
    expect(text).toMatch(/named once per error/)
  })

  it('leaves the duplicate hint out when no refusal is a duplicate', () => {
    const alert = buildPushRejectionAlert([rejection('KWN-4-TEST01-B', NO_PIN_PUSH_ERROR)])!
    expect(alert.lines.join('\n')).not.toMatch(/Duplicate orderNo/)
    expect(alert.lines).toContain(`• KWN-4-TEST01-B, collection 27/10/2026: ${NO_PIN_PUSH_ERROR}`)
  })

  it('caps the list and counts the rest', () => {
    const many = Array.from({ length: PUSH_ALERT_MAX_LISTED + 3 }, (_, i) => rejection(`VIN-TEST${i}-B`))
    const alert = buildPushRejectionAlert(many)!
    expect(alert.title).toBe(`⚠️ OptimoRoute refused ${PUSH_ALERT_MAX_LISTED + 3} orders`)
    expect(alert.lines.filter((l) => l.startsWith('• '))).toHaveLength(PUSH_ALERT_MAX_LISTED)
    expect(alert.lines).toContain('…and 3 more.')
  })
})

describe('createOrUpdateOrders — per-order verdicts survive an all-failed request', () => {
  // The OR client is Deno-only (excluded from tsc) — loaded via a runtime
  // import path like stops.test.ts; fetch stubbed at the network boundary.
  const OR_CLIENT = '../../supabase/functions/_shared/optimoroute.ts'
  type Push = (apiKey: string, orders: unknown[]) => Promise<Array<Record<string, unknown>>>

  const order = (orderNo: string) => ({
    orderNo,
    date: '2026-10-27',
    duration: 5,
    priority: 'H',
    location: { latitude: -32.21, longitude: 115.85 },
  })

  async function pushWith(response: Response, orderNos: string[]) {
    const { createOrUpdateOrders } = (await import(/* @vite-ignore */ OR_CLIENT)) as {
      createOrUpdateOrders: Push
    }
    vi.stubGlobal('fetch', vi.fn(async () => response))
    return createOrUpdateOrders('k3y', orderNos.map(order))
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the per-order message when OR sets success=false because every order failed', async () => {
    // OR docs: top-level success is false when ALL orders fail. The old parser
    // read only the envelope, so a lone refused order logged
    // "create_or_update_orders failed" and lost the real reason.
    const results = await pushWith(
      json({ success: false, orders: [{ success: false, code: DUPLICATE_ORDER_NO_CODE, message: DUPLICATE }] }),
      ['SOP-TEST01-G'],
    )
    expect(results).toEqual([
      { orderNo: 'SOP-TEST01-G', success: false, error: DUPLICATE, code: DUPLICATE_ORDER_NO_CODE, failedAt: 'order' },
    ])
  })

  it('marks a refused order in a mixed batch as the order, the rest as pushed', async () => {
    const results = await pushWith(
      json({ success: true, orders: [{ success: true }, { success: false, message: DUPLICATE }] }),
      ['KWN-4-TEST01-B', 'SOP-TEST01-G'],
    )
    expect(results).toEqual([
      { orderNo: 'KWN-4-TEST01-B', success: true },
      { orderNo: 'SOP-TEST01-G', success: false, error: DUPLICATE, code: undefined, failedAt: 'order' },
    ])
  })

  it('an envelope failure with no per-order results is the request, not the orders', async () => {
    const results = await pushWith(json({ success: false, code: 'ERR_INVALID_PARAMETERS' }), ['A', 'B'])
    expect(results.map((r) => [r.failedAt, r.error])).toEqual([
      ['request', 'ERR_INVALID_PARAMETERS'],
      ['request', 'ERR_INVALID_PARAMETERS'],
    ])
  })

  it('an HTTP error is the request', async () => {
    const results = await pushWith(new Response('Bad Gateway', { status: 502 }), ['A'])
    expect(results).toEqual([{ orderNo: 'A', success: false, error: 'HTTP 502: Bad Gateway', failedAt: 'request' }])
  })

  it('a short results array fails the unmatched order as the request (never a silent push)', async () => {
    const results = await pushWith(json({ success: true, orders: [{ success: true }] }), ['A', 'B'])
    expect(results[1]).toEqual({ orderNo: 'B', success: false, error: 'no result returned', failedAt: 'request' })
  })
})
