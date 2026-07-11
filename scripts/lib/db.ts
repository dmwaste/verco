// scripts/lib/db.ts
//
// Shared Supabase read helpers for the one-off reconcile/audit/backfill scripts.
// Extracted from the five scripts that each carried a private `pagedIn` copy
// (issue #389.2). Three of those copies (reconcile-vv, reconcile-kwn,
// create-missing-kwn) chunked the `.in()` filter but never paginated the RESULT
// rows, so a chunk matching more than PostgREST's max-rows cap (default 1000)
// was silently truncated — a truncated set feeds "missing"/reconcile decisions
// and can create duplicate bookings (same class as the KWN ~4k-row incident,
// memory `supabase-range-pagination-order`). This shared version paginates both.

import { type SupabaseClient } from '@supabase/supabase-js'

const CHUNK = 100 // values per `.in()` filter
const PAGE = 1000 // rows per `.range()` page (PostgREST default max-rows)

/** Minimal PostgREST builder surface a `refine` callback may use. */
export type Filterable = {
  eq: (column: string, value: string) => Filterable
  or: (filter: string) => Filterable
}

type Pageable = {
  order: (column: string, opts: { ascending: boolean }) => Pageable
  range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
}

/**
 * Fetch every row where `column` is in `values`, chunking the filter (100/query)
 * AND paginating rows (1000/page) so nothing is silently capped.
 *
 * `refine` optionally narrows each query (e.g. `q => q.or('notes.is.null,notes.eq.')`);
 * it runs before the order+range so the filter applies to every page.
 *
 * Requires the target table to have an `id` column — pagination orders by `id`
 * (a stable key; `.range()` without an order skips/dupes rows). `id` need not be
 * in `select`. Every table these scripts read (booking, eligible_properties,
 * booking_item, service, collection_date, collection_stop) has an `id` PK.
 */
export async function pagedIn<T>(
  verco: SupabaseClient,
  table: string,
  select: string,
  column: string,
  values: string[],
  refine?: (q: Filterable) => Filterable,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    let from = 0
    while (true) {
      let q = verco.from(table).select(select).in(column, chunk) as unknown as Filterable
      if (refine) q = refine(q)
      const { data, error } = await (q as unknown as Pageable)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`load ${table}: ${error.message}`)
      if (!data || data.length === 0) break
      out.push(...(data as T[]))
      if (data.length < PAGE) break
      from += PAGE
    }
  }
  return out
}

/** De-duplicate a string array, preserving no particular order. */
export function uniq(xs: string[]): string[] {
  return [...new Set(xs)]
}
