import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pagedIn, type Filterable } from '../../scripts/lib/db'

// Coverage for the shared reconcile-script pager (scripts/lib/db.ts, #389.2).
// Two axes must both hold or a reconcile run silently truncates and can create
// duplicate bookings (the KWN ~4k-row incident class):
//   1. the `.in()` filter is chunked (100 values/query), and
//   2. each chunk's RESULT rows are paginated (1000 rows/page), ordered by id,
//      with the caller's `refine` re-applied to every page.

type PageResult = { data: unknown[] | null; error: { message: string } | null }

interface Builder {
  select: (cols: string) => Builder
  in: (col: string, values: string[]) => Builder
  eq: (col: string, value: string) => Builder
  or: (filter: string) => Builder
  order: (col: string, opts: { ascending: boolean }) => Builder
  range: (from: number, to: number) => Promise<PageResult>
}

/** Fake PostgREST builder that records how pagedIn drove it. */
function makeVerco(pageData: (ctx: { from: number }) => PageResult) {
  const inChunks: string[][] = []
  const ranges: Array<[number, number]> = []
  const orders: Array<{ column: string; ascending: boolean }> = []

  const builder: Builder = {
    select: () => builder,
    in: (_col, values) => {
      inChunks.push(values)
      return builder
    },
    eq: () => builder,
    or: () => builder,
    order: (column, opts) => {
      orders.push({ column, ascending: opts.ascending })
      return builder
    },
    range: (from, to) => {
      ranges.push([from, to])
      return Promise.resolve(pageData({ from }))
    },
  }

  const verco = { from: () => builder } as unknown as SupabaseClient
  return { verco, inChunks, ranges, orders }
}

/** n placeholder rows — content is irrelevant, only the count drives paging. */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }))

describe('pagedIn — filter chunking', () => {
  it('splits 250 values into 3 .in() chunks of 100 / 100 / 50', async () => {
    // Each chunk resolves in a single page (<1000 rows), so .in() is called
    // exactly once per chunk.
    const { verco, inChunks } = makeVerco(() => ({ data: rows(1), error: null }))
    const values = Array.from({ length: 250 }, (_, i) => `v${i}`)

    await pagedIn(verco, 'booking', 'id', 'id', values)

    expect(inChunks).toHaveLength(3)
    expect(inChunks.map((c) => c.length)).toEqual([100, 100, 50])
  })
})

describe('pagedIn — row pagination', () => {
  it('pages a 2500-row chunk into (0-999)/(1000-1999)/(2000-2499), ordered by id, refine per page', async () => {
    // Typed as pagedIn sees it — (q: Filterable) => Filterable — so the spy
    // matches the real refine contract (the runtime object is the fuller Builder).
    const refine = vi.fn((q: Filterable) => q.or('notes.is.null,notes.eq.'))
    const { verco, ranges, orders } = makeVerco(({ from }) => {
      if (from === 0) return { data: rows(1000), error: null }
      if (from === 1000) return { data: rows(1000), error: null }
      if (from === 2000) return { data: rows(500), error: null }
      return { data: [], error: null }
    })
    // One chunk (<= 100 values) whose result spans three pages.
    const values = Array.from({ length: 5 }, (_, i) => `v${i}`)

    const result = await pagedIn(verco, 'booking', 'id, notes', 'id', values, refine)

    expect(result).toHaveLength(2500)
    // Each page requests a FULL 1000-row window (from, from+999). The third
    // request is (2000, 2999) even though only 500 rows (2000-2499) come back —
    // that short page (< 1000) is precisely what terminates the loop.
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
    // Every page ordered by id ascending (a stable key; .range() without an
    // order skips AND dupes rows).
    expect(orders).toEqual([
      { column: 'id', ascending: true },
      { column: 'id', ascending: true },
      { column: 'id', ascending: true },
    ])
    // refine re-applied to each page's query, not just the first.
    expect(refine).toHaveBeenCalledTimes(3)
  })
})

describe('pagedIn — error propagation', () => {
  it('throws "load <table>: <message>" when a page errors mid-iteration', async () => {
    const { verco } = makeVerco(({ from }) => {
      if (from === 0) return { data: rows(1000), error: null }
      // Second page fails — pagedIn must surface it, not truncate to page 1.
      return { data: null, error: { message: 'connection reset' } }
    })
    const values = Array.from({ length: 5 }, (_, i) => `v${i}`)

    await expect(pagedIn(verco, 'booking', 'id', 'id', values)).rejects.toThrow(
      'load booking: connection reset',
    )
  })
})
