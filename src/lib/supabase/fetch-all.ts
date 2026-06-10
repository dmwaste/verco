/**
 * Drains a PostgREST query past the server's max_rows cap (1000) — without
 * this, large result sets are silently truncated with no error.
 *
 * `page` must apply `.range(from, to)` to a freshly built query each call.
 * Query errors THROW (surfacing via the route error boundary) — a failed
 * page must never render as a complete-but-empty result: crews told
 * "no work today" because of a transient error is worse than an error page.
 */
export async function fetchAllRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    if (error) throw new Error(`fetchAllRows page ${from / 1000}: ${error.message}`)
    rows.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  return rows
}
