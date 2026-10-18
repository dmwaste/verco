import { describe, it, expect } from 'vitest'
import { loadCallerMatches } from '@/app/(admin)/admin/lookup/caller-matches'

/**
 * Query contract for the Teams caller lookup (VER-316). Recording fake for the
 * chainable PostgREST builder — no live DB. RLS is the only tenant scope: the
 * lookup must never narrow to the admin client switcher (a VV caller was missed
 * while the switcher sat on KWN), and a failed read must never render as
 * "no Verco contact" — Kim would then book the caller in as a new resident.
 */

type Filter = [op: string, col: string, value: unknown]
interface TableCall {
  select: string
  filters: Filter[]
  orders: Array<[string, unknown]>
  limit?: number
}
type TableResult = { data: unknown[] | null; error: { message: string } | null }

function makeFake(results: Record<string, TableResult>) {
  const calls: Record<string, TableCall> = {}
  const client = {
    from(table: string) {
      const call: TableCall = { select: '', filters: [], orders: [] }
      calls[table] = call
      const result = results[table] ?? { data: [], error: null }
      const builder = {
        select(cols: string) {
          call.select = cols
          return builder
        },
        in(col: string, values: unknown[]) {
          call.filters.push(['in', col, values])
          return builder
        },
        eq(col: string, value: unknown) {
          call.filters.push(['eq', col, value])
          return builder
        },
        is(col: string, value: unknown) {
          call.filters.push(['is', col, value])
          return builder
        },
        order(col: string, opts?: unknown) {
          call.orders.push([col, opts])
          return builder
        },
        limit(n: number) {
          call.limit = n
          return builder
        },
        then(res: (v: TableResult) => unknown, rej?: (e: unknown) => unknown) {
          return Promise.resolve(result).then(res, rej)
        },
      }
      return builder
    },
  }
  return { client: client as unknown as Parameters<typeof loadCallerMatches>[0], calls }
}

const contactA = { id: 'c-a', full_name: 'Alex Able', mobile_e164: '+61412345678', email: 'a@example.com' }
const contactB = { id: 'c-b', full_name: 'Bo Baker', mobile_e164: '+61412345678', email: 'bo@example.com' }

describe('loadCallerMatches', () => {
  it('finds contacts by every candidate form and asks for nothing else on a miss', async () => {
    const { client, calls } = makeFake({ contacts: { data: [], error: null } })

    const result = await loadCallerMatches(client, ['+61862564449', '0862564449'])

    expect(result).toEqual({ ok: true, data: [] })
    expect(calls.contacts?.filters).toContainEqual(['in', 'mobile_e164', ['+61862564449', '0862564449']])
    expect(Object.keys(calls)).toEqual(['contacts'])
  })

  it('scopes by RLS only — never by a client filter, whatever the switcher says', async () => {
    const { client, calls } = makeFake({
      contacts: { data: [contactA], error: null },
      booking: { data: [], error: null },
      service_ticket: { data: [], error: null },
    })

    await loadCallerMatches(client, ['+61412345678'])

    for (const call of Object.values(calls)) {
      expect(call.filters.map(([, col]) => col)).not.toContain('client_id')
    }
  })

  it('lists every contact sharing the number, each with its own bookings and tickets', async () => {
    const { client, calls } = makeFake({
      contacts: { data: [contactA, contactB], error: null },
      booking: {
        data: [
          {
            id: 'b-2', ref: 'VV-COT-2', status: 'Confirmed', contact_id: 'c-a', geo_address: null,
            collection_area: { code: 'VV-COT' },
            eligible_properties: { formatted_address: '1 Test St, Cottesloe', address: '1 Test St' },
            booking_item: [
              { collection_date: { date: '2026-11-09' } },
              { collection_date: { date: '2026-11-02' } },
              { collection_date: { date: '2026-11-02' } },
            ],
          },
          {
            id: 'b-1', ref: 'KWN-1-1', status: 'Completed', contact_id: 'c-b', geo_address: 'Verge near 5 Test Rd',
            collection_area: { code: 'KWN-1' },
            eligible_properties: null,
            booking_item: [],
          },
        ],
        error: null,
      },
      service_ticket: {
        data: [
          { id: 't-1', display_id: 'TKT-1001', subject: 'Missed pickup', status: 'open', created_at: '2026-10-01T02:00:00Z', contact_id: 'c-a' },
        ],
        error: null,
      },
    })

    const result = await loadCallerMatches(client, ['+61412345678'])

    expect(calls.booking?.filters).toContainEqual(['in', 'contact_id', ['c-a', 'c-b']])
    expect(calls.booking?.filters).toContainEqual(['is', 'deleted_at', null])
    expect(calls.booking?.orders[0]).toEqual(['created_at', { ascending: false }])
    expect(calls.service_ticket?.filters).toContainEqual(['in', 'contact_id', ['c-a', 'c-b']])
    expect(calls.service_ticket?.orders[0]).toEqual(['created_at', { ascending: false }])

    expect(result).toEqual({
      ok: true,
      data: [
        {
          contact: { id: 'c-a', fullName: 'Alex Able', mobile: '+61412345678', email: 'a@example.com' },
          bookings: [
            { id: 'b-2', ref: 'VV-COT-2', status: 'Confirmed', areaCode: 'VV-COT', collectionDates: ['2026-11-02', '2026-11-09'], address: '1 Test St, Cottesloe' },
          ],
          tickets: [
            { id: 't-1', displayId: 'TKT-1001', subject: 'Missed pickup', status: 'open', createdAt: '2026-10-01T02:00:00Z' },
          ],
        },
        {
          contact: { id: 'c-b', fullName: 'Bo Baker', mobile: '+61412345678', email: 'bo@example.com' },
          bookings: [
            { id: 'b-1', ref: 'KWN-1-1', status: 'Completed', areaCode: 'KWN-1', collectionDates: [], address: 'Verge near 5 Test Rd' },
          ],
          tickets: [],
        },
      ],
    })
  })

  it('reports a failed contact search instead of "no match"', async () => {
    const { client } = makeFake({ contacts: { data: null, error: { message: 'statement timeout' } } })

    const result = await loadCallerMatches(client, ['+61412345678'])

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('statement timeout')
  })

  it.each(['booking', 'service_ticket'])('reports a failed %s read instead of an empty list', async (table) => {
    const { client } = makeFake({
      contacts: { data: [contactA], error: null },
      [table]: { data: null, error: { message: 'permission denied' } },
    })

    const result = await loadCallerMatches(client, ['+61412345678'])

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('permission denied')
  })
})
