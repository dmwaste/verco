import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchAllEligibleProperties } from '../lib/airtable-vv'

const baseId = 'appTEST'
const token = 'fake-token'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function mockAirtableResponse(body: object) {
  vi.mocked(global.fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => body,
  } as Response)
}

// Regression guard for commit 2a2e97a: Airtable's REST API returns
// `multipleRecordLinks` fields as arrays of record-ID *strings*
// (e.g. ["recABC"]), NOT arrays of {id, name} objects like the MCP wrapper.
// A previous parser used `Council_Code?.[0]?.id` and silently produced
// undefined on every row, collapsing every councilCode to null.
describe('fetchAllEligibleProperties — Airtable REST linked-record parsing', () => {
  it('resolves Council_Code record-ID strings to the council code name via the lookup', async () => {
    // First fetch: Council Code lookup table — one record mapping recABC → "FRE-S".
    mockAirtableResponse({
      records: [{ id: 'recABC', fields: { Council_ID: 'FRE-S' } }],
    })
    // Second fetch: Eligible Properties — one row whose Council_Code is the
    // bare record-ID string array shape returned by the REST API.
    mockAirtableResponse({
      records: [
        {
          id: 'recPROP1',
          fields: {
            Address: '12 Test St, Fremantle WA',
            Council_Code: ['recABC'],
            Latitude: -32.0569,
            Longitude: 115.7439,
          },
        },
      ],
    })

    const result = await fetchAllEligibleProperties(baseId, token)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: 'recPROP1',
      address: '12 Test St, Fremantle WA',
      councilCode: 'FRE-S',
      latitude: -32.0569,
      longitude: 115.7439,
    })
  })

  it('returns councilCode = null for orphan record-IDs not present in the lookup', async () => {
    // Lookup has only recABC; the property row references recUNKNOWN.
    mockAirtableResponse({
      records: [{ id: 'recABC', fields: { Council_ID: 'FRE-S' } }],
    })
    mockAirtableResponse({
      records: [
        {
          id: 'recORPHAN',
          fields: {
            Address: '99 Orphan Way, Nowhere WA',
            Council_Code: ['recUNKNOWN'],
          },
        },
      ],
    })

    const result = await fetchAllEligibleProperties(baseId, token)

    expect(result).toHaveLength(1)
    expect(result[0]?.councilCode).toBeNull()
    expect(result[0]?.id).toBe('recORPHAN')
  })
})
