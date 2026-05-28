import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { geocodeAddress } from '../lib/geocode'

const apiKey = 'fake-api-key'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function mockGoogleResponse(body: object, status = 200) {
  vi.mocked(global.fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response)
}

describe('geocodeAddress', () => {
  it('returns a GeocodeResult on a successful OK response', async () => {
    mockGoogleResponse({
      status: 'OK',
      results: [{
        geometry: { location: { lat: -31.9421, lng: 115.8267 } },
        place_id: 'ChIJ_subiaco',
        formatted_address: '8/112 Hensman Rd, Subiaco WA 6008, Australia',
      }],
    })

    const result = await geocodeAddress('8/112 Hensman Road SUBIACO', apiKey)

    expect(result).toEqual({
      lat: -31.9421,
      lng: 115.8267,
      placeId: 'ChIJ_subiaco',
      formattedAddress: '8/112 Hensman Rd, Subiaco WA 6008, Australia',
    })
  })

  it('returns null on ZERO_RESULTS', async () => {
    mockGoogleResponse({ status: 'ZERO_RESULTS', results: [] })
    expect(await geocodeAddress('totally fake address', apiKey)).toBeNull()
  })

  it('retries on OVER_QUERY_LIMIT and succeeds on second attempt', async () => {
    mockGoogleResponse({ status: 'OVER_QUERY_LIMIT', results: [] })
    mockGoogleResponse({
      status: 'OK',
      results: [{
        geometry: { location: { lat: 1, lng: 2 } },
        place_id: 'p',
        formatted_address: 'a',
      }],
    })

    const result = await geocodeAddress('addr', apiKey, { initialDelayMs: 1 })
    expect(result).not.toBeNull()
    expect(result?.lat).toBe(1)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('returns null after max retries on persistent OVER_QUERY_LIMIT', async () => {
    for (let i = 0; i < 5; i++) {
      mockGoogleResponse({ status: 'OVER_QUERY_LIMIT', results: [] })
    }
    const result = await geocodeAddress('addr', apiKey, { initialDelayMs: 1, maxRetries: 4 })
    expect(result).toBeNull()
  })

  it('throws on a network-level error (non-OK HTTP status)', async () => {
    mockGoogleResponse({}, 500)
    await expect(geocodeAddress('addr', apiKey, { initialDelayMs: 1, maxRetries: 0 }))
      .rejects.toThrow(/HTTP 500/)
  })

  it('URL-encodes the address in the query string', async () => {
    mockGoogleResponse({ status: 'ZERO_RESULTS', results: [] })
    await geocodeAddress('21/94 Marine Parade', apiKey)
    const url = vi.mocked(global.fetch).mock.calls[0]?.[0] as string
    expect(url).toContain('address=21%2F94%20Marine%20Parade')
  })
})
