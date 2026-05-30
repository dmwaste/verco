import { describe, it, expect, vi } from 'vitest'
import {
  resolveOnBehalfClient,
  type OnBehalfClient,
} from '@/lib/proxy/resolve-on-behalf-client'

const KWN: OnBehalfClient = { id: 'kwn', slug: 'kwn', contractor_id: 'dm' }
const VV: OnBehalfClient = { id: 'vv', slug: 'vv', contractor_id: 'dm' }

describe('resolveOnBehalfClient (VER-233)', () => {
  it('uses the explicit switcher selection when the cookie resolves', async () => {
    const lookupById = vi.fn(async () => KWN)
    const firstAccessible = vi.fn(async () => VV)

    const result = await resolveOnBehalfClient('kwn', lookupById, firstAccessible)

    expect(result).toEqual(KWN)
    // Tier 1 hit — the fallback query must not run.
    expect(firstAccessible).not.toHaveBeenCalled()
  })

  it('falls back to the first accessible client when no cookie is set (the bug: no silent /admin bounce)', async () => {
    const lookupById = vi.fn(async () => null)
    const firstAccessible = vi.fn(async () => VV)

    const result = await resolveOnBehalfClient(undefined, lookupById, firstAccessible)

    expect(result).toEqual(VV)
    // No cookie — the by-id lookup must be skipped entirely.
    expect(lookupById).not.toHaveBeenCalled()
  })

  it('falls back when the cookie points at a client the user cannot access (RLS hid it)', async () => {
    const lookupById = vi.fn(async () => null)
    const firstAccessible = vi.fn(async () => VV)

    const result = await resolveOnBehalfClient('stale-id', lookupById, firstAccessible)

    expect(result).toEqual(VV)
    expect(lookupById).toHaveBeenCalledWith('stale-id')
  })

  it('returns null only when the user has no accessible client (proxy then bounces to /admin)', async () => {
    const result = await resolveOnBehalfClient(
      undefined,
      async () => null,
      async () => null,
    )

    expect(result).toBeNull()
  })
})
