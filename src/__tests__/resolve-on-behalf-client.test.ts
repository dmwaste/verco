import { describe, it, expect, vi } from 'vitest'
import {
  resolveOnBehalfClient,
  type OnBehalfClient,
} from '@/lib/proxy/resolve-on-behalf-client'

const KWN: OnBehalfClient = { id: 'kwn', slug: 'kwn', contractor_id: 'dm' }
const VV: OnBehalfClient = { id: 'vv', slug: 'vv', contractor_id: 'dm' }

// A D&M contractor user can act as both tenants; a WMRC (Verge Valet)
// client-tier user can only ever act as their own.
const BOTH = [KWN.id, VV.id]
const VV_ONLY = [VV.id]

describe('resolveOnBehalfClient (VER-233)', () => {
  it('uses the explicit switcher selection when the cookie resolves', async () => {
    const lookupById = vi.fn(async () => KWN)
    const firstAccessible = vi.fn(async () => VV)

    const result = await resolveOnBehalfClient('kwn', BOTH, lookupById, firstAccessible)

    expect(result).toEqual(KWN)
    // Tier 1 hit — the fallback query must not run.
    expect(firstAccessible).not.toHaveBeenCalled()
  })

  it('falls back to the first accessible client when no cookie is set (the bug: no silent /admin bounce)', async () => {
    const lookupById = vi.fn(async () => null)
    const firstAccessible = vi.fn(async () => VV)

    const result = await resolveOnBehalfClient(undefined, BOTH, lookupById, firstAccessible)

    expect(result).toEqual(VV)
    // No cookie — the by-id lookup must be skipped entirely.
    expect(lookupById).not.toHaveBeenCalled()
  })

  it('falls back when an in-scope cookie no longer resolves (client deactivated)', async () => {
    const lookupById = vi.fn(async () => null)
    const firstAccessible = vi.fn(async () => VV)

    // KWN is accessible, so it IS looked up — but the row is gone/inactive,
    // so tier 1 misses and tier 3 supplies the default.
    const result = await resolveOnBehalfClient(KWN.id, BOTH, lookupById, firstAccessible)

    expect(result).toEqual(VV)
    expect(lookupById).toHaveBeenCalledWith(KWN.id)
  })

  it('returns null only when the user has no accessible client (proxy then bounces to /admin)', async () => {
    const result = await resolveOnBehalfClient(
      undefined,
      BOTH,
      async () => null,
      async () => null,
    )

    expect(result).toBeNull()
  })
})

describe('resolveOnBehalfClient — tenant scoping', () => {
  // The live bug: `client` is public-SELECT, so the cookie-less fallback query
  // ("first active client by name") returned City of Kwinana for EVERY admin.
  // A Verge Valet staffer opening "+ New Booking" was scoped into the Kwinana
  // tenant and told their resident was "not eligible for VERCO Kwinana".
  // Single-client users never write the switcher cookie (the ClientSwitcher
  // renders a static pill when they have only one client), so this was their
  // every-time path, not an edge case.
  it('never resolves a client-tier user outside their own tenant when no cookie is set', async () => {
    // Simulates the live defect exactly: an UNSCOPED fallback query (the
    // public-SELECT `client` table ordered by name) hands back City of Kwinana
    // to a Verge Valet user. The resolver must refuse it rather than pass it
    // through as x-client-id.
    const unscopedFirstByName = vi.fn(async () => KWN)

    const result = await resolveOnBehalfClient(
      undefined,
      VV_ONLY,
      async () => null,
      unscopedFirstByName,
    )

    expect(result).toBeNull()
    expect(result).not.toEqual(KWN)
  })

  it('accepts the fallback when the query is correctly scoped', async () => {
    const scopedFirstByName = vi.fn(async () => VV)

    const result = await resolveOnBehalfClient(
      undefined,
      VV_ONLY,
      async () => null,
      scopedFirstByName,
    )

    expect(result).toEqual(VV)
  })

  it('ignores a switcher cookie naming a client outside the accessible set', async () => {
    const lookupById = vi.fn(async () => KWN)
    const firstAccessible = vi.fn(async () => VV)

    // Stale/tampered cookie pointing at Kwinana, held by a Verge Valet user.
    const result = await resolveOnBehalfClient(
      KWN.id,
      VV_ONLY,
      lookupById,
      firstAccessible,
    )

    expect(result).toEqual(VV)
    // The out-of-scope id must not even be looked up.
    expect(lookupById).not.toHaveBeenCalled()
  })

  it('fails closed when the accessible set is empty (never treats it as unfiltered)', async () => {
    const lookupById = vi.fn(async () => KWN)
    const firstAccessible = vi.fn(async () => KWN)

    const result = await resolveOnBehalfClient(KWN.id, [], lookupById, firstAccessible)

    expect(result).toBeNull()
    expect(lookupById).not.toHaveBeenCalled()
    expect(firstAccessible).not.toHaveBeenCalled()
  })
})
