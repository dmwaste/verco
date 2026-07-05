import { describe, it, expect } from 'vitest'
import { getRangerScope } from '@/lib/field/ranger-scope'

/**
 * Regression guard for the ranger header-pill tenant leak.
 *
 * `collection_area` is public-SELECT (RLS USING(true)) — it does NOT
 * tenant-scope, so any raw query returns every client's areas. The field
 * layout's pill used exactly such a raw query, so a Verge Valet ranger saw
 * Kwinana (KWN-*) codes in their header. The fix routes the pill through this
 * helper's scoped area set. These tests pin that the scope's areas (ids AND
 * the codes the pill now renders) are filtered to the ranger's own client, so
 * an unscoped source can't creep back in.
 */

type EqFilter = [string, unknown]

interface MockOpts {
  userId: string | null
  roleRow: { client_id: string; sub_client_id: string | null } | null
  /** Rows the (server-side-scoped) collection_area query resolves to. */
  areas: Array<{ id: string; code: string }>
  client: { name: string; place_out_hours_before: number } | null
  record: { areaFilters: EqFilter[] }
}

function makeSupabase(opts: MockOpts) {
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const pass = () => b
    b.select = pass
    b.order = pass
    b.eq = (col: string, val: unknown) => {
      if (table === 'collection_area') opts.record.areaFilters.push([col, val])
      return b
    }
    b.maybeSingle = () =>
      Promise.resolve({ data: table === 'user_roles' ? opts.roleRow : null, error: null })
    b.single = () =>
      Promise.resolve({ data: table === 'client' ? opts.client : null, error: null })
    // collection_area is awaited directly (no single) → the builder is thenable.
    b.then = (resolve: (r: { data: unknown; error: null }) => void) =>
      resolve({ data: table === 'collection_area' ? opts.areas : null, error: null })
    return b
  }
  return {
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: opts.userId ? { id: opts.userId } : null } }),
    },
    from: (table: string) => builder(table),
  } as unknown as Parameters<typeof getRangerScope>[0]
}

const VV = '5215645f-ca8f-4cff-8b7d-d5a8f7991ec7'
const VV_AREAS = [
  { id: 'a1', code: 'COT' },
  { id: 'a2', code: 'MOS' },
  { id: 'a3', code: 'PEP' },
]

describe('getRangerScope — tenant-scoped area set', () => {
  it('exposes area CODES scoped to the ranger client (drives the header pill)', async () => {
    const record = { areaFilters: [] as EqFilter[] }
    const scope = await getRangerScope(
      makeSupabase({
        userId: 'u1',
        roleRow: { client_id: VV, sub_client_id: null },
        areas: VV_AREAS,
        client: { name: 'Verge Valet', place_out_hours_before: 24 },
        record,
      }),
    )

    expect(scope?.areaCodes).toEqual(['COT', 'MOS', 'PEP'])
    expect(scope?.areaIds).toEqual(['a1', 'a2', 'a3'])
  })

  it('filters the collection_area query by client_id (so KWN never leaks in)', async () => {
    const record = { areaFilters: [] as EqFilter[] }
    await getRangerScope(
      makeSupabase({
        userId: 'u1',
        roleRow: { client_id: VV, sub_client_id: null },
        areas: VV_AREAS,
        client: { name: 'Verge Valet', place_out_hours_before: 24 },
        record,
      }),
    )

    expect(record.areaFilters).toContainEqual(['client_id', VV])
    expect(record.areaFilters).toContainEqual(['is_active', true])
    // Whole-client ranger (no sub-client) → no sub_client narrowing applied.
    expect(record.areaFilters.some(([col]) => col === 'sub_client_id')).toBe(false)
  })

  it('narrows to the sub-client when the role row carries one', async () => {
    const record = { areaFilters: [] as EqFilter[] }
    await getRangerScope(
      makeSupabase({
        userId: 'u1',
        roleRow: { client_id: VV, sub_client_id: 'cot-sub' },
        areas: [{ id: 'a1', code: 'COT' }],
        client: { name: 'Verge Valet', place_out_hours_before: 24 },
        record,
      }),
    )

    expect(record.areaFilters).toContainEqual(['sub_client_id', 'cot-sub'])
  })

  it('fails closed (null) for a non-ranger / role-less user', async () => {
    const scope = await getRangerScope(
      makeSupabase({
        userId: 'u1',
        roleRow: null,
        areas: [],
        client: null,
        record: { areaFilters: [] },
      }),
    )
    expect(scope).toBeNull()
  })
})
