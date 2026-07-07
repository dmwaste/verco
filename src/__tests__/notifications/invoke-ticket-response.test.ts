import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { invokeNotifyTicketResponse } from '@/lib/notifications/invoke-ticket-response'

// Minimal fake of the browser Supabase client: only auth.getSession is used.
function fakeClient(accessToken: string | null) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: accessToken ? { access_token: accessToken } : null },
      }),
    },
  } as unknown as Parameters<typeof invokeNotifyTicketResponse>[0]
}

describe('invokeNotifyTicketResponse', () => {
  const OLD_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'ok' }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = OLD_ENV
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('POSTs to the EF with the session bearer and response id', async () => {
    await invokeNotifyTicketResponse(fakeClient('tok-123'), 'resp-abc')
    expect(fetch).toHaveBeenCalledTimes(1)
    const call = vi.mocked(fetch).mock.calls[0]
    expect(call).toBeDefined()
    const [url, init] = call as [string, RequestInit]
    expect(url).toBe('https://proj.supabase.co/functions/v1/notify-ticket-response')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-123')
    expect(JSON.parse(init.body as string)).toEqual({ ticket_response_id: 'resp-abc' })
  })

  it('skips the fetch when there is no session token', async () => {
    await invokeNotifyTicketResponse(fakeClient(null), 'resp-abc')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never throws when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(
      invokeNotifyTicketResponse(fakeClient('tok-123'), 'resp-abc'),
    ).resolves.toBeUndefined()
  })
})
