import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The caller lookup shows resident contact PII, so the page itself admits staff
 * roles only — and checks BEFORE any contact query. The admin host's proxy
 * already blocks other roles, but on a tenant subdomain (admin-host redirect
 * off) the (admin) layout has no role guard, and field/ranger must receive zero
 * contact fields (Red Line #2).
 */

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ rpc, from })),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    // Real redirect throws to halt rendering — mirror that.
    throw new Error(`REDIRECT:${url}`)
  }),
}))

import CallerLookupPage from '@/app/(admin)/admin/lookup/page'

const searchParams = Promise.resolve({ phone: ' 61412345678' })

describe('caller lookup staff-only guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['field', 'ranger', 'resident', 'strata', null])(
    'redirects role=%s away without querying contacts',
    async (role) => {
      rpc.mockResolvedValue({ data: role })
      await expect(CallerLookupPage({ searchParams })).rejects.toThrow(/^REDIRECT:\/$/)
      expect(from).not.toHaveBeenCalled()
    },
  )
})
