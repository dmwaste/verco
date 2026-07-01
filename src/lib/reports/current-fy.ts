/**
 * Current-FY resolver for the admin SLA dashboard (VER-179 §5.3).
 *
 * Pure, deterministic helper for `reports/page.tsx`: no Supabase imports, no
 * network, no wall-clock reads. The server shell fetches the financial-year
 * rows (`.from('financial_year').select('id, is_current')`, public-SELECT) and
 * hands them here to resolve the current FY id, which is then passed as a prop
 * to `ReportsClient` and folded into BC's queryKey.
 *
 * `is_current` is the authoritative flag (maintained by the FY-rollover job);
 * this never reads the clock to decide which FY is current. Returns the id of
 * the first row with `is_current === true`, or null when the rows are
 * null/undefined/empty, no row is current, or the current row has no usable id.
 */

/** Minimal shape this helper needs — wider rows (e.g. `financial_year.Row`) are accepted. */
export interface FinancialYearRow {
  id: string
  is_current: boolean
}

/**
 * Resolve the current financial-year id from the financial_year rows.
 *
 * @param rows financial_year rows (`{ id, is_current }`), or null/undefined.
 * @returns the first current FY's id, or null when none is resolvable.
 */
export function pickCurrentFyId(
  rows: readonly FinancialYearRow[] | null | undefined,
): string | null {
  if (!rows) return null

  // First current row with a usable id. A malformed current row (missing/null
  // id) never shadows a later well-formed current row.
  const current = rows.find(
    (row) =>
      row?.is_current === true &&
      typeof row.id === 'string' &&
      row.id.length > 0,
  )

  return current?.id ?? null
}
