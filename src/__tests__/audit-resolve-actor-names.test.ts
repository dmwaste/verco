import { describe, it, expect, vi } from 'vitest'
import { resolveActorNames } from '@/lib/audit/resolve'

/**
 * Mocks the minimal shape of the Supabase client that `resolveActorNames`
 * uses: two table queries, each ending in `.in('id', ...)` returning a
 * `{ data }` promise. We feed pre-canned rows per table.
 */
type Row = Record<string, unknown>

function makeSupabase(tables: Record<string, Row[]>) {
  const fromCalls: string[] = []
  return {
    fromCalls,
    from(table: string) {
      fromCalls.push(table)
      const rows = tables[table] ?? []
      return {
        select: () => ({
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          in: (_col: string, _ids: string[]) => Promise.resolve({ data: rows }),
        }),
      }
    },
  }
}

describe('resolveActorNames', () => {
  it('returns empty map when userIds is empty', async () => {
    const supabase = makeSupabase({})
    // @ts-expect-error — minimal mock, full SupabaseClient type not satisfied
    const map = await resolveActorNames(supabase, [])
    expect(map).toEqual({})
    // Should not even query the database
    expect(supabase.fromCalls).toEqual([])
  })

  it('uses display_name when populated', async () => {
    const supabase = makeSupabase({
      profiles: [
        { id: 'u1', display_name: 'Alice Resident', contact_id: null },
      ],
    })
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    const map = await resolveActorNames(supabase, ['u1'])
    expect(map).toEqual({ u1: 'Alice Resident' })
    // No need to hit contacts when display_name covers everyone
    expect(supabase.fromCalls).toEqual(['profiles'])
  })

  it('falls back to contacts.full_name when display_name is null', async () => {
    const supabase = makeSupabase({
      profiles: [
        { id: 'u1', display_name: null, contact_id: 'c1' },
      ],
      contacts: [
        { id: 'c1', full_name: 'Dan Taylor' },
      ],
    })
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    const map = await resolveActorNames(supabase, ['u1'])
    expect(map).toEqual({ u1: 'Dan Taylor' })
    expect(supabase.fromCalls).toEqual(['profiles', 'contacts'])
  })

  it('leaves unresolved when display_name AND contact_id are both null', async () => {
    const supabase = makeSupabase({
      profiles: [
        { id: 'u1', display_name: null, contact_id: null },
      ],
    })
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    const map = await resolveActorNames(supabase, ['u1'])
    expect(map).toEqual({})
    // No contact fetch needed when no profile has a contact_id
    expect(supabase.fromCalls).toEqual(['profiles'])
  })

  it('leaves unresolved when contact_id is set but contact has no full_name', async () => {
    const supabase = makeSupabase({
      profiles: [
        { id: 'u1', display_name: null, contact_id: 'c1' },
      ],
      contacts: [
        { id: 'c1', full_name: null },
      ],
    })
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    const map = await resolveActorNames(supabase, ['u1'])
    expect(map).toEqual({})
  })

  it('stitches a mixed batch: some display_names, some contact fallbacks, some unresolved', async () => {
    const supabase = makeSupabase({
      profiles: [
        { id: 'u1', display_name: 'Alice', contact_id: null },
        { id: 'u2', display_name: null, contact_id: 'c2' },
        { id: 'u3', display_name: null, contact_id: 'c3' },
        { id: 'u4', display_name: null, contact_id: null },
      ],
      contacts: [
        { id: 'c2', full_name: 'Bob Staff' },
        { id: 'c3', full_name: 'Carla Council' },
      ],
    })
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    const map = await resolveActorNames(supabase, ['u1', 'u2', 'u3', 'u4'])
    expect(map).toEqual({
      u1: 'Alice',
      u2: 'Bob Staff',
      u3: 'Carla Council',
      // u4 omitted — caller renders "System" fallback
    })
  })

  it('handles a profile having both display_name AND contact_id (display_name wins)', async () => {
    const supabase = makeSupabase({
      profiles: [
        { id: 'u1', display_name: 'Preferred Name', contact_id: 'c1' },
      ],
      // contacts not queried when display_name covers the row
    })
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    const map = await resolveActorNames(supabase, ['u1'])
    expect(map).toEqual({ u1: 'Preferred Name' })
    expect(supabase.fromCalls).toEqual(['profiles'])
  })

  it('returns empty map when profile query returns null (RLS denied / db error)', async () => {
    const supabase = {
      fromCalls: [] as string[],
      from(table: string) {
        this.fromCalls.push(table)
        return {
          select: () => ({
            in: () => Promise.resolve({ data: null }),
          }),
        }
      },
    }
    // @ts-expect-error — test mock partial-shape, not full SupabaseClient
    const map = await resolveActorNames(supabase, ['u1'])
    expect(map).toEqual({})
  })
})

// vi is imported above; silence the unused warning if linter sees it
void vi
