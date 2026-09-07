import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * setCurrentAdminClient (#485) — the switcher WRITE path must scope to
 * `accessible_client_ids()`, not `client.is_active` alone (public-SELECT table
 * → any active tenant id would pass). A client-tier user POSTing another
 * tenant's id must get ok:false and NO cookie write.
 */
const h = vi.hoisted(() => ({
  accessibleIds: [] as string[],
  activeClientIds: [] as string[],
  cookieWrites: [] as Array<[string, string]>,
  rpc: [] as string[],
}))

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      set: (name: string, value: string) => {
        h.cookieWrites.push([name, value])
      },
    }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      rpc: (name: string) => {
        h.rpc.push(name)
        return Promise.resolve({ data: h.accessibleIds, error: null })
      },
      from: () => {
        let id: string | null = null
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = (col: string, val: string) => {
          if (col === 'id') id = val
          return b
        }
        b.maybeSingle = () =>
          Promise.resolve({
            data: id && h.activeClientIds.includes(id) ? { id } : null,
            error: null,
          })
        return b
      },
    }),
}))

import { setCurrentAdminClient } from '@/lib/admin/actions'

describe('setCurrentAdminClient — tenant scope (#485)', () => {
  beforeEach(() => {
    h.accessibleIds = ['kwn']
    h.activeClientIds = ['kwn', 'vv'] // both active; only kwn accessible
    h.cookieWrites = []
    h.rpc = []
  })

  it('rejects an ACTIVE client the user cannot access — no cookie written', async () => {
    const r = await setCurrentAdminClient('vv')
    expect(r).toEqual({ ok: false, error: 'Client not accessible.' })
    expect(h.cookieWrites).toEqual([])
    expect(h.rpc).toContain('accessible_client_ids')
  })

  it('accepts an accessible active client and writes the cookie', async () => {
    const r = await setCurrentAdminClient('kwn')
    expect(r).toEqual({ ok: true, data: { id: 'kwn' } })
    expect(h.cookieWrites).toEqual([['verco_admin_client', 'kwn']])
  })

  it('fails closed when the user has no accessible clients', async () => {
    h.accessibleIds = []
    const r = await setCurrentAdminClient('kwn')
    expect(r.ok).toBe(false)
    expect(h.cookieWrites).toEqual([])
  })
})
