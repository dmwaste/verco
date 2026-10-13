/**
 * sendRoutes — the nightly 8pm "Share routes" call (send-routes-to-optimoroute).
 *
 * The OptimoRoute client is Deno-only (supabase/functions/_shared, excluded
 * from tsc), so it's loaded through a runtime-only import path: tsc never
 * follows it, Vitest transforms it like any other module. fetch is stubbed at
 * the network boundary — the routing API is the one thing we can't call here.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

type SendRoutes = (apiKey: string, date: string) => Promise<'sent' | 'nothing_to_send'>
type DispatchStatus = {
  state: 'not_sent' | 'scheduled' | 'sent'
  sentAtUtc: string | null
  scheduledForUtc: string | null
}
type GetDispatchStatus = (apiKey: string, date: string) => Promise<DispatchStatus>

const OR_CLIENT = '../../supabase/functions/_shared/optimoroute.ts'

let sendRoutes: SendRoutes
let getDispatchStatus: GetDispatchStatus

beforeAll(async () => {
  ;({ sendRoutes, getDispatchStatus } = (await import(/* @vite-ignore */ OR_CLIENT)) as {
    sendRoutes: SendRoutes
    getDispatchStatus: GetDispatchStatus
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('sendRoutes', () => {
  it('shares the date’s routes with customer notifications, like the manual Share routes', async () => {
    const fetchMock = stubFetch(200, { success: true, date: '2026-10-12' })

    await expect(sendRoutes('k3y', '2026-10-12')).resolves.toBe('sent')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.optimoroute.com/v1/send_routes?key=k3y')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      date: '2026-10-12',
      sendNotifications: true,
    })
  })

  it('treats "nothing new to send" as a no-op, not a failure', async () => {
    stubFetch(200, {
      success: false,
      code: 'ERR_NOTHING_TO_SEND',
      message: 'there is nothing new to send for this date',
    })

    await expect(sendRoutes('k3y', '2026-10-12')).resolves.toBe('nothing_to_send')
  })

  it('throws with the OptimoRoute code on any other rejection', async () => {
    stubFetch(200, { success: false, code: 'ERR_SYNC', message: 'routes and notifications' })

    await expect(sendRoutes('k3y', '2026-10-12')).rejects.toThrow(/send_routes\(2026-10-12\).*ERR_SYNC/)
  })

  it('throws on an HTTP error without echoing the API key', async () => {
    stubFetch(503, 'Service Unavailable')

    const err: unknown = await sendRoutes('k3y', '2026-10-12').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const { message } = err as Error
    expect(message).toMatch(/send_routes\(2026-10-12\).*HTTP 503/)
    expect(message).not.toContain('k3y')
  })
})

describe('getDispatchStatus', () => {
  it('reads the date’s route share state — a share scheduled ahead freezes the plan', async () => {
    const fetchMock = stubFetch(200, {
      success: true,
      date: '2026-10-12',
      live: false,
      routes: { state: 'scheduled', sentAtUtc: null, scheduledForUtc: '2026-10-11T12:00:00Z' },
      notifications: { state: 'scheduled', sentAtUtc: null, scheduledForUtc: '2026-10-11T12:00:00Z' },
    })

    await expect(getDispatchStatus('k3y', '2026-10-12')).resolves.toEqual({
      state: 'scheduled',
      sentAtUtc: null,
      scheduledForUtc: '2026-10-11T12:00:00Z',
    })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://api.optimoroute.com/v1/get_dispatch_status?key=k3y&date=2026-10-12')
  })

  it('throws on an HTTP error', async () => {
    stubFetch(500, 'boom')

    await expect(getDispatchStatus('k3y', '2026-10-12')).rejects.toThrow(
      /get_dispatch_status\(2026-10-12\).*HTTP 500/,
    )
  })
})
