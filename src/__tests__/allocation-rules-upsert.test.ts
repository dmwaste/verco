/**
 * Regression guard for the 2026-07-03 KWN swap-config wipe (PR #364).
 *
 * upsertAllocationRules MUST upsert in place (stable row ids) and only delete
 * categories dropped from the submitted set. allocation_conversion_rule FKs
 * allocation_rules with ON DELETE CASCADE, so the old delete-then-insert shape
 * silently cascade-deleted the Kwinana "3 ancillary -> 1 green" swap config on
 * every admin save. These tests pin the write shape: reverting to an unscoped
 * `.delete().eq('collection_area_id')` (without the dropped-category `.in()`)
 * is exactly the regression.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// category_id is z.string().uuid() — fixtures must be real UUIDs
const CAT_BULK = '11111111-1111-4111-8111-111111111111'
const CAT_ANC = '22222222-2222-4222-8222-222222222222'

interface UpsertCall {
  rows: unknown
  opts: unknown
}

const calls: { upserts: UpsertCall[]; deletes: string[][] } = {
  upserts: [],
  deletes: [],
}
let existingRows: Array<{ category_id: string }> = []
// Rows the mocked DELETE ... RETURNING reports as deleted. Defaults to "all
// requested ids deleted"; override to simulate an RLS-filtered delete.
let deleteReturns: (ids: string[]) => Array<{ id: string }> = (ids) =>
  ids.map((id) => ({ id }))

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ getAll: () => [] }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      upsert: (rows: unknown, opts: unknown) => {
        calls.upserts.push({ rows, opts })
        return Promise.resolve({ error: null })
      },
      select: () => ({
        eq: () => Promise.resolve({ data: existingRows, error: null }),
      }),
      delete: () => ({
        eq: () => ({
          in: (_col: string, ids: string[]) => ({
            select: () => {
              calls.deletes.push(ids)
              return Promise.resolve({ data: deleteReturns(ids), error: null })
            },
          }),
        }),
      }),
    }),
  }),
}))

import { upsertAllocationRules } from '@/app/(admin)/admin/clients/actions'

beforeEach(() => {
  calls.upserts = []
  calls.deletes = []
  existingRows = []
  deleteReturns = (ids) => ids.map((id) => ({ id }))
})

describe('upsertAllocationRules — conversion-rule cascade regression (2026-07-03 KWN wipe)', () => {
  it('resubmitting an unchanged rule set upserts in place and issues NO delete', async () => {
    existingRows = [{ category_id: CAT_BULK }, { category_id: CAT_ANC }]

    const res = await upsertAllocationRules('area-1', [
      { category_id: CAT_BULK, max_collections: 2 },
      { category_id: CAT_ANC, max_collections: 3 },
    ])

    expect(res.ok).toBe(true)
    expect(calls.upserts).toHaveLength(1)
    // Stable-id conflict target — (area, category) rows keep their ids, so
    // dependent allocation_conversion_rule rows survive the save.
    expect(calls.upserts[0]?.opts).toEqual({
      onConflict: 'collection_area_id,category_id',
    })
    // Delete-then-insert here is what cascade-wiped the KWN swap config.
    expect(calls.deletes).toHaveLength(0)
  })

  it('dropping a category deletes only that category (scoped .in)', async () => {
    existingRows = [{ category_id: CAT_BULK }, { category_id: CAT_ANC }]

    const res = await upsertAllocationRules('area-1', [
      { category_id: CAT_BULK, max_collections: 2 },
    ])

    expect(res.ok).toBe(true)
    expect(calls.deletes).toEqual([[CAT_ANC]])
  })

  it('empty payload preserves the clear-all behaviour', async () => {
    existingRows = [{ category_id: CAT_BULK }, { category_id: CAT_ANC }]

    const res = await upsertAllocationRules('area-1', [])

    expect(res.ok).toBe(true)
    expect(calls.upserts).toHaveLength(0)
    expect(calls.deletes).toEqual([[CAT_BULK, CAT_ANC]])
  })

  it('rejects duplicate category_ids (would 21000 the single upsert statement)', async () => {
    const res = await upsertAllocationRules('area-1', [
      { category_id: CAT_BULK, max_collections: 2 },
      { category_id: CAT_BULK, max_collections: 3 },
    ])

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/duplicate category/i)
    expect(calls.upserts).toHaveLength(0)
    expect(calls.deletes).toHaveLength(0)
  })

  it('surfaces an RLS-filtered delete as an error, not silent success', async () => {
    existingRows = [{ category_id: CAT_BULK }, { category_id: CAT_ANC }]
    deleteReturns = () => [] // RLS filtered every row — nothing actually deleted

    const res = await upsertAllocationRules('area-1', [
      { category_id: CAT_BULK, max_collections: 2 },
    ])

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/not fully applied/i)
  })
})
