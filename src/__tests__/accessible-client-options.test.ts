import { describe, it, expect, vi } from 'vitest'
import {
  resolveAccessibleClientOptions,
  type ClientOption,
} from '@/lib/admin/accessible-clients'

const VV: ClientOption = { id: 'vv-id', name: 'Verge Valet' }
const KWN: ClientOption = { id: 'kwn-id', name: 'City of Kwinana' }

describe('resolveAccessibleClientOptions (#456)', () => {
  it('narrows the client query to the accessible ids (client-admin sees only their council)', async () => {
    const fetchAccessibleIds = vi.fn(async () => ['vv-id'])
    const fetchClientsByIds = vi.fn(async () => [VV])

    const result = await resolveAccessibleClientOptions(fetchAccessibleIds, fetchClientsByIds)

    expect(result).toEqual([VV])
    // The whole point of the fix: the query must be narrowed by the ids,
    // never a bare public-SELECT read of every tenant.
    expect(fetchClientsByIds).toHaveBeenCalledWith(['vv-id'])
  })

  it('returns all accessible clients for contractor tiers (both councils)', async () => {
    const fetchAccessibleIds = vi.fn(async () => ['kwn-id', 'vv-id'])
    const fetchClientsByIds = vi.fn(async () => [KWN, VV])

    const result = await resolveAccessibleClientOptions(fetchAccessibleIds, fetchClientsByIds)

    expect(result).toEqual([KWN, VV])
    expect(fetchClientsByIds).toHaveBeenCalledWith(['kwn-id', 'vv-id'])
  })

  it('never queries the public-SELECT client table when the caller has no accessible clients', async () => {
    const fetchClientsByIds = vi.fn(async () => [KWN, VV])

    const result = await resolveAccessibleClientOptions(async () => [], fetchClientsByIds)

    expect(result).toEqual([])
    expect(fetchClientsByIds).not.toHaveBeenCalled()
  })

  it('treats a null RPC result (no session / RPC error) as no access', async () => {
    const fetchClientsByIds = vi.fn(async () => [KWN, VV])

    const result = await resolveAccessibleClientOptions(async () => null, fetchClientsByIds)

    expect(result).toEqual([])
    expect(fetchClientsByIds).not.toHaveBeenCalled()
  })
})
