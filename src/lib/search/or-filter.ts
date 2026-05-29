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
