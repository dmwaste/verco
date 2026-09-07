/**
 * Email canonicalisation — the single brain for email identity matching.
 *
 * Mirror pair: supabase/functions/_shared/email.ts (SOURCE — edit here) →
 * src/lib/email.ts, kept in sync by scripts/sync-mirrors.sh.
 *
 * Why this exists: GoTrue lowercases every address it stores, so auth.users is
 * always canonical — but our own tables are only as canonical as the form input
 * that produced them. An admin typing "Hazel.Bone@council.gov.au" used to create
 * an auth duplicate-hit (case-insensitive) followed by a byte-exact profiles miss
 * (case-sensitive), stranding the new staff member in a 409 dead-end (#575).
 *
 * Store rule (every write path): normaliseEmail() before writing, so new rows are
 * canonical. Match rule: emailMatchPattern() + ilike when reading back, because
 * the existing corpus predates this rule and still holds mixed-case rows.
 */

/**
 * Canonicalise an email for storage and for auth lookups: trimmed and lowercased,
 * matching what GoTrue persists in auth.users.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Build a LIKE pattern that matches an address case-insensitively and nothing else.
 *
 * PostgREST `ilike` treats `%` and `_` as wildcards, and `_` is legal in a real
 * local-part — so `first_last@x.com` would otherwise also match `firstXlast@x.com`.
 * Escaping them (backslash first, so it isn't double-escaped) keeps the match exact
 * apart from case.
 */
export function emailMatchPattern(raw: string): string {
  return normaliseEmail(raw).replace(/[\\%_]/g, '\\$&')
}
