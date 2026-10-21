// EF-only shared module (NOT mirrored — consumers are Deno EFs).
//
// Drain a PostgREST list query page by page. Prod caps a response at 1,000
// rows (max-rows) and a longer result is silently cut — an unpaginated cron
// fetch stranded bookings that way (#548). Used by the watchdog EFs
// (notification-health-check, stale-closeout-check).

/** PostgREST page size on prod (max-rows); a longer result is silently cut. */
const PAGE_SIZE = 1000

export type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/**
 * Drain an ordered query page by page. The caller's query MUST carry a stable
 * `.order()` (e.g. created_at, id) — `.range()` without one skips and
 * duplicates rows across pages (memory supabase-range-pagination-order.md).
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<{ ok: true; rows: T[] } | { ok: false; error: string }> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) return { ok: false, error: error.message }
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE_SIZE) return { ok: true, rows }
  }
}
