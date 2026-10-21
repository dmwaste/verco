/**
 * notificationClaimStore — the PostgREST side of the send claim (#671), shared
 * by send-notification and notify-ticket-response.
 *
 * The unique index is NULLS NOT DISTINCT over (booking_id, notification_type,
 * channel, reference_id), so a NULL booking (a ticket with no booking) or a
 * NULL reference (booking-level types) is its own key value. The holder lookup
 * must match that exactly — `IS NULL`, never "any value" — or a ticket reply's
 * claim could be judged against another ticket's row.
 *
 * Deno-only module loaded through a runtime-only import (tsc never follows it).
 */
import { beforeAll, describe, expect, it } from 'vitest'

type Row = {
  booking_id: string | null
  contact_id: string | null
  client_id: string
  channel: string
  notification_type: string
  to_address: string
  reference_id?: string | null
}
type Store = {
  insertClaim: (row: Row) => Promise<{ id: string } | { conflict: true } | { error: string }>
  findHolder: (row: Row) => Promise<unknown>
  releaseClaim: (id: string, reason: string) => Promise<boolean>
}

const MODULE = '../../../supabase/functions/_shared/notification-claim-store.ts'
let notificationClaimStore: (supabase: unknown) => Store

beforeAll(async () => {
  ;({ notificationClaimStore } = (await import(/* @vite-ignore */ MODULE)) as {
    notificationClaimStore: (supabase: unknown) => Store
  })
})

/** Records the filter chain of each query and answers with a scripted result. */
function recordingClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
  const queries: Array<{ op: string; payload?: unknown; filters: Array<[string, string, unknown]> }> = []
  const client = {
    from: () => {
      const q: (typeof queries)[number] = { op: 'select', filters: [] }
      queries.push(q)
      const chain: Record<string, unknown> = {}
      const filter = (kind: string) => (col: string, val: unknown) => {
        q.filters.push([kind, col, val])
        return chain
      }
      chain.insert = (payload: unknown) => {
        q.op = 'insert'
        q.payload = payload
        return chain
      }
      chain.update = (payload: unknown) => {
        q.op = 'update'
        q.payload = payload
        return chain
      }
      chain.select = () => chain
      chain.eq = filter('eq')
      chain.is = filter('is')
      chain.in = filter('in')
      chain.limit = () => chain
      chain.single = async () => result
      chain.maybeSingle = async () => result
      chain.then = (resolve: (v: unknown) => void) => resolve(result)
      return chain
    },
  }
  return { client, queries }
}

const TICKET_ROW: Row = {
  booking_id: null,
  contact_id: 'c1',
  client_id: 'client-1',
  channel: 'email',
  notification_type: 'ticket_response',
  to_address: 'resident@example.test',
  reference_id: 'resp-1',
}

describe('notificationClaimStore', () => {
  it('inserts the claim as queued and returns its id', async () => {
    const { client, queries } = recordingClient({ data: { id: 'log-9' }, error: null })
    expect(await notificationClaimStore(client).insertClaim(TICKET_ROW)).toEqual({ id: 'log-9' })
    expect(queries[0]).toMatchObject({ op: 'insert', payload: { status: 'queued', booking_id: null, reference_id: 'resp-1' } })
  })

  it('reads a unique violation as a held key', async () => {
    const { client } = recordingClient({ data: null, error: { code: '23505', message: 'duplicate key' } })
    expect(await notificationClaimStore(client).insertClaim(TICKET_ROW)).toEqual({ conflict: true })
  })

  it('passes any other insert error through', async () => {
    const { client } = recordingClient({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } })
    expect(await notificationClaimStore(client).insertClaim(TICKET_ROW)).toEqual({
      error: 'invalid input syntax for type uuid',
    })
  })

  it('looks up a ticket claim with booking_id IS NULL', async () => {
    const { client, queries } = recordingClient({ data: null, error: null })
    await notificationClaimStore(client).findHolder(TICKET_ROW)
    expect(queries[0]!.filters).toEqual(
      expect.arrayContaining([
        ['is', 'booking_id', null],
        ['eq', 'notification_type', 'ticket_response'],
        ['eq', 'channel', 'email'],
        ['eq', 'reference_id', 'resp-1'],
        ['in', 'status', ['queued', 'sent']],
      ]),
    )
  })

  it('looks up a booking-level claim with reference_id IS NULL', async () => {
    const { client, queries } = recordingClient({ data: null, error: null })
    await notificationClaimStore(client).findHolder({
      ...TICKET_ROW,
      booking_id: 'b1',
      notification_type: 'booking_created',
      reference_id: null,
    })
    expect(queries[0]!.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'booking_id', 'b1'],
        ['is', 'reference_id', null],
      ]),
    )
  })

  it('releases only a still-queued claim', async () => {
    const { client, queries } = recordingClient({ data: [{ id: 'log-1' }], error: null })
    expect(await notificationClaimStore(client).releaseClaim('log-1', 'stale')).toBe(true)
    expect(queries[0]).toMatchObject({ op: 'update', payload: { status: 'failed', error_message: 'stale' } })
    expect(queries[0]!.filters).toEqual(expect.arrayContaining([['eq', 'id', 'log-1'], ['eq', 'status', 'queued']]))
  })
})
