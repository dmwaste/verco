import { describe, it, expect } from 'vitest'
import { resolveActorNames, resolveFkLabels } from '@/lib/audit/resolve'

/**
 * `resolveActorNames` now delegates to the `resolve_actor_names` SECURITY
 * DEFINER RPC (migration 20260701030000). The display_name-vs-contact
 * fallback + the staff-role PII gate live in SQL (verified behaviourally
 * against prod via impersonation). The app-layer responsibility that remains
 * — and what these tests cover — is: skip the call when there are no ids, map
 * the returned rows into a `{ userId: name }` record, drop null names, and
 * treat null data (RLS denied / db error) as "resolve nothing".
 *
 * We mock the minimal shape used: `supabase.rpc(name, args)` → `{ data }`.
 */
type Row = { user_id: string; name: string | null }

function makeSupabase(rows: Row[] | null) {
  const rpcCalls: Array<{ fn: string; args: unknown }> = []
  return {
    rpcCalls,
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args })
      return Promise.resolve({ data: rows })
    },
  }
}

describe('resolveActorNames', () => {
  it('returns empty map when userIds is empty — no RPC call', async () => {
    const supabase = makeSupabase([])
    // @ts-expect-error — minimal mock, full SupabaseClient type not satisfied
    const map = await resolveActorNames(supabase, [])
    expect(map).toEqual({})
    expect(supabase.rpcCalls).toEqual([])
  })

  it('calls resolve_actor_names with the user ids', async () => {
    const supabase = makeSupabase([{ user_id: 'u1', name: 'Nicholas Brook' }])
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    await resolveActorNames(supabase, ['u1'])
    expect(supabase.rpcCalls).toEqual([
      { fn: 'resolve_actor_names', args: { p_user_ids: ['u1'] } },
    ])
  })

  it('maps returned rows into a userId → name record', async () => {
    const supabase = makeSupabase([
      { user_id: 'u1', name: 'Nicholas Brook' },
      { user_id: 'u2', name: 'Dan Taylor' },
    ])
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    const map = await resolveActorNames(supabase, ['u1', 'u2'])
    expect(map).toEqual({ u1: 'Nicholas Brook', u2: 'Dan Taylor' })
  })

  it('drops rows with a null name (unresolved → caller renders "System")', async () => {
    const supabase = makeSupabase([
      { user_id: 'u1', name: 'Alice' },
      { user_id: 'u2', name: null },
    ])
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    const map = await resolveActorNames(supabase, ['u1', 'u2'])
    expect(map).toEqual({ u1: 'Alice' })
  })

  it('returns empty map when the RPC returns null (RLS denied / db error / non-staff caller)', async () => {
    const supabase = makeSupabase(null)
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    const map = await resolveActorNames(supabase, ['u1'])
    expect(map).toEqual({})
  })
})

/**
 * `*_by` FK columns (created_by, removed_by, …) resolve through
 * `profiles.display_name`, which is NULL for staff whose name lives on their
 * linked contact — History showed "Created By: Unknown" for the very person
 * named in the actor column (property notes walk-through, 13/10/2026). Ids the
 * direct read can't label fall back to resolve_actor_names; labels the direct
 * read did find are never replaced.
 */
describe('resolveFkLabels — profiles fallback', () => {
  function makeFkSupabase(profileRows: Array<{ id: string; display_name: string | null }>, rpcRows: Row[]) {
    const rpcCalls: Array<{ fn: string; args: unknown }> = []
    return {
      rpcCalls,
      from: () => ({ select: () => ({ in: () => Promise.resolve({ data: profileRows }) }) }),
      rpc(fn: string, args: unknown) {
        rpcCalls.push({ fn, args })
        return Promise.resolve({ data: rpcRows })
      },
    }
  }

  it('fills a NULL display_name from resolve_actor_names', async () => {
    const supabase = makeFkSupabase([{ id: 'u1', display_name: null }], [{ user_id: 'u1', name: 'Daniel Taylor' }])
    // @ts-expect-error — minimal mock
    const labels = await resolveFkLabels(supabase, { created_by: new Set(['u1']), removed_by: new Set(['u1']) })
    expect(labels).toEqual({ u1: 'Daniel Taylor' })
  })

  it('keeps a direct display_name and only asks the RPC for the rest', async () => {
    const supabase = makeFkSupabase(
      [{ id: 'u1', display_name: 'Kim Lenton' }, { id: 'u2', display_name: null }],
      [{ user_id: 'u2', name: 'Ben Davies' }],
    )
    // @ts-expect-error — minimal mock
    const labels = await resolveFkLabels(supabase, { created_by: new Set(['u1', 'u2']) })
    expect(labels).toEqual({ u1: 'Kim Lenton', u2: 'Ben Davies' })
    expect(supabase.rpcCalls).toEqual([{ fn: 'resolve_actor_names', args: { p_user_ids: ['u2'] } }])
  })

  it('makes no RPC call when every profile resolved directly', async () => {
    const supabase = makeFkSupabase([{ id: 'u1', display_name: 'Kim Lenton' }], [])
    // @ts-expect-error — minimal mock
    await resolveFkLabels(supabase, { created_by: new Set(['u1']) })
    expect(supabase.rpcCalls).toEqual([])
  })
})
