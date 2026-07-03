import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Admin client-switcher scoping (P1 security fix).
 *
 * `client` is a public-SELECT table, so a re-query filtered only by
 * `is_active` validates ANY active client id. getCurrentAdminClient /
 * getAccessibleAdminClients must instead scope to `accessible_client_ids()`,
 * so a tampered switcher cookie can't move the admin surface into another
 * council's data. These tests pin that contract with a recording Supabase
 * mock — the load-bearing case is "cookie points at a non-accessible client →
 * falls through to the accessible default, and the client query carries
 * .in('id', accessibleIds)".
 */

const h = vi.hoisted(() => ({
  cookieId: undefined as string | undefined,
  headerId: null as string | null,
  accessibleIds: [] as string[],
  // rows the client query resolves to (already filtered to accessibleIds by
  // the mock, mirroring what .in('id', accessibleIds) does server-side)
  clients: [] as Array<{ id: string; slug: string; name: string; contractor_id: string }>,
  recorded: { rpc: [] as string[], clientFilters: [] as Array<[string, string, unknown]> },
}))

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'verco_admin_client' && h.cookieId !== undefined
          ? { value: h.cookieId }
          : undefined,
    }),
  headers: () =>
    Promise.resolve({
      get: (name: string) => (name === 'x-client-id' ? h.headerId : null),
    }),
}))

vi.mock('@/lib/supabase/server', () => {
  function makeBuilder() {
    const builder: Record<string, unknown> = {}
    const passthrough = () => builder
    builder.select = passthrough
    builder.order = passthrough
    builder.in = (col: string, vals: unknown) => {
      h.recorded.clientFilters.push(['in', col, vals])
      return builder
    }
    builder.eq = (col: string, val: unknown) => {
      h.recorded.clientFilters.push(['eq', col, val])
      return builder
    }
    // Thenable — awaiting the chain resolves the recorded client rows, keeping
    // only those the mock's accessible set would return (server-side .in()).
    builder.then = (resolve: (r: { data: unknown; error: null }) => void) => {
      const scoped = h.clients.filter((c) => h.accessibleIds.includes(c.id))
      resolve({ data: scoped, error: null })
    }
    return builder
  }
  return {
    createClient: () =>
      Promise.resolve({
        rpc: (name: string) => {
          h.recorded.rpc.push(name)
          return Promise.resolve({ data: h.accessibleIds, error: null })
        },
        from: () => makeBuilder(),
      }),
  }
})

import { getCurrentAdminClient, getAccessibleAdminClients } from '@/lib/admin/current-client'

const CLIENTS = [
  { id: 'kwn', slug: 'kwinana', name: 'City of Kwinana', contractor_id: 'dm' },
  { id: 'vv', slug: 'vergevalet', name: 'Verge Valet', contractor_id: 'dm' },
]

beforeEach(() => {
  h.cookieId = undefined
  h.headerId = null
  h.accessibleIds = []
  h.clients = CLIENTS
  h.recorded = { rpc: [], clientFilters: [] }
})

describe('getCurrentAdminClient — tenant scoping', () => {
  it('honours the switcher cookie when it points at an accessible client', async () => {
    h.accessibleIds = ['kwn', 'vv']
    h.cookieId = 'vv'

    const result = await getCurrentAdminClient()
    expect(result?.id).toBe('vv')
  })

  it('falls through to the accessible default when the cookie is tampered to a non-accessible client', async () => {
    // Client-admin who can only see Kwinana forges the Verge Valet id.
    h.accessibleIds = ['kwn']
    h.clients = [CLIENTS[0]!] // server-side .in(['kwn']) returns only Kwinana
    h.cookieId = 'vv'

    const result = await getCurrentAdminClient()
    expect(result?.id).toBe('kwn') // NOT 'vv' — the tamper is ignored
  })

  it('scopes the client query to accessible_client_ids(), not just is_active', async () => {
    h.accessibleIds = ['kwn']
    h.clients = [CLIENTS[0]!]
    h.cookieId = 'vv'

    await getCurrentAdminClient()
    expect(h.recorded.rpc).toContain('accessible_client_ids')
    expect(h.recorded.clientFilters).toContainEqual(['in', 'id', ['kwn']])
    expect(h.recorded.clientFilters).toContainEqual(['eq', 'is_active', true])
  })

  it('defaults to the first accessible client (by name) when no cookie or header is set', async () => {
    h.accessibleIds = ['kwn', 'vv']

    const result = await getCurrentAdminClient()
    expect(result?.id).toBe('kwn') // ordered by name; City of Kwinana first
  })

  it('uses the x-client-id header when no cookie is present', async () => {
    h.accessibleIds = ['kwn', 'vv']
    h.headerId = 'vv'

    const result = await getCurrentAdminClient()
    expect(result?.id).toBe('vv')
  })

  it('returns null when the user has no accessible clients (fails closed)', async () => {
    h.accessibleIds = []
    h.cookieId = 'vv'

    const result = await getCurrentAdminClient()
    expect(result).toBeNull()
  })
})

describe('getAccessibleAdminClients — switcher list', () => {
  it('returns only clients in the accessible set', async () => {
    h.accessibleIds = ['kwn']
    h.clients = CLIENTS

    const result = await getAccessibleAdminClients()
    expect(result.map((c) => c.id)).toEqual(['kwn']) // Verge Valet excluded
  })

  it('returns an empty list when the user has no accessible clients', async () => {
    h.accessibleIds = []

    const result = await getAccessibleAdminClients()
    expect(result).toEqual([])
  })
})
