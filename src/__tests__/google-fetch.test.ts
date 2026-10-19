/**
 * googleFetch — the Google Maps fetch wrapper used by geocode-properties.
 * The API key rides in the query string; a network-failure error message can
 * carry the full URL, and geocode-properties shows its per-row errors to staff
 * and sends its 500 body to Sentry. The wrapper must never let the key out.
 *
 * Deno-only module loaded through a runtime-only import path (tsc never
 * follows it). fetch is stubbed at the global boundary.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

type GoogleFetch = (url: URL, label: string) => Promise<Response>

const MODULE = '../../supabase/functions/_shared/google-fetch.ts'
const KEY = 'FAKE_TEST_KEY_0123456789'

let googleFetch: GoogleFetch

beforeAll(async () => {
  ;({ googleFetch } = (await import(/* @vite-ignore */ MODULE)) as { googleFetch: GoogleFetch })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function geocodeUrl(): URL {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', '7 Fixture Way, Anketell WA')
  url.searchParams.set('key', KEY)
  return url
}

describe('googleFetch', () => {
  it('passes the response through on success', async () => {
    const res = new Response('{"status":"OK"}')
    const fetchMock = vi.fn().mockResolvedValue(res)
    vi.stubGlobal('fetch', fetchMock)

    await expect(googleFetch(geocodeUrl(), 'Geocoding')).resolves.toBe(res)
    expect(fetchMock).toHaveBeenCalledWith(geocodeUrl().toString())
  })

  it('rethrows a network failure without the URL or the key', async () => {
    const leaky = new TypeError(`error sending request for url (${geocodeUrl().toString()}): connection refused`)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(leaky))

    const err = await googleFetch(geocodeUrl(), 'Geocoding').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('Google Geocoding request failed: TypeError')
    expect((err as Error).message).not.toContain(KEY)
    expect((err as Error).message).not.toContain('maps.googleapis.com')
  })

  it('handles a non-Error rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(`boom ${KEY}`))

    await expect(googleFetch(geocodeUrl(), 'Places Autocomplete')).rejects.toThrow(
      'Google Places Autocomplete request failed: network error',
    )
  })
})
