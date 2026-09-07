/**
 * Builds a PostgREST `.or()` filter for a free-text "contains" search across
 * one or more columns, e.g. an admin search box.
 *
 * The search term is user input and may contain a comma (or other PostgREST
 * reserved chars). PostgREST reads a *bare* comma inside `.or()` as the
 * separator BETWEEN conditions, so interpolating the raw term yields
 * `PGRST100 "failed to parse logic tree"` (HTTP 400). The Supabase client
 * swallows that 400, and the search silently returns nothing — e.g. an admin
 * pasting "Smith, John" or "Unit 5, 18 Sulphur Rd" gets an empty result.
 *
 * Wrapping each value in double quotes makes the comma (and every other
 * reserved char) literal. Inside a quoted value only `"` and `\` are special,
 * so those are escaped. LIKE wildcards in the term (`%`, `_`) are deliberately
 * left untouched, preserving the existing contains-search behaviour.
 *
 * Same bug class as `buildEligibleOrFilter` (public booking eligibility
 * lookup, hotfix #114). See `search-or-filter.test.ts`.
 */
export function buildSearchOrFilter(columns: string[], term: string): string {
  const value = `"%${term.replace(/[\\"]/g, (c) => `\\${c}`)}%"`
  return columns.map((col) => `${col}.ilike.${value}`).join(',')
}

/**
 * Free-text search across text columns PLUS an enum column (#497).
 *
 * Postgres has no `~~*` (ILIKE) operator for enum types, so putting an enum
 * column into `buildSearchOrFilter` 400s the whole request with
 * `operator does not exist: ncn_reason ~~* unknown` — and, per the `.or()`
 * gotcha, the Supabase client swallows that into `data: null`, so the admin
 * sees an empty list instead of an error (NCN list search, 03/08 prod logs).
 *
 * Instead the term is matched client-side against the enum's known values
 * (case-insensitive substring) and any hits are added as a quoted
 * `col.in.("A","B")` condition. No hit → the enum column is simply omitted.
 */
export function buildSearchOrFilterWithEnum(
  textColumns: string[],
  enumColumn: string,
  enumValues: readonly string[],
  term: string,
): string {
  const needle = term.toLowerCase()
  const hits = enumValues.filter((v) => v.toLowerCase().includes(needle))
  const text = buildSearchOrFilter(textColumns, term)
  if (hits.length === 0) return text
  const list = hits.map((v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(',')
  return `${text},${enumColumn}.in.(${list})`
}
