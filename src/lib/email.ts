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

/**
 * Mistyped D&M staff domains → the domain staff meant (13/10/2026).
 *
 * Staff booking on a resident's behalf typed their own address with the wrong
 * domain, and Verco emailed residents' booking details to these third-party
 * domains (55 Kwinana emails, Jul–Oct; none of the four is D&M's). Every contact
 * write rejects them with a suggestion; the DB CHECK
 * `contacts_email_not_mistyped_staff_domain` is the backstop for anything else.
 */
export const MISTYPED_STAFF_DOMAINS: Readonly<Record<string, string>> = {
  'dmwaste.com': 'dmwaste.com.au',
  'dmwastemanagement.com': 'dmwastemanagement.com.au',
  'verco.com': 'verco.au',
  'verco.com.au': 'verco.au',
}

/** A user-facing rejection for a mistyped staff domain, or null when the email is fine. */
export function mistypedEmailDomainMessage(raw: string): string | null {
  const domain = normaliseEmail(raw).split('@')[1] ?? ''
  const meant = MISTYPED_STAFF_DOMAINS[domain]
  return meant ? `@${domain} isn't a D&M address. Did you mean @${meant}?` : null
}

/**
 * zod `.superRefine(rejectMistypedEmailDomain)` adapter. Structurally typed (no
 * zod import) so one helper serves the zod 3 Edge Functions and the zod 4 app.
 */
export function rejectMistypedEmailDomain(
  value: string,
  ctx: { addIssue: (issue: { code: 'custom'; message: string }) => void },
): void {
  const message = mistypedEmailDomainMessage(value)
  if (message) ctx.addIssue({ code: 'custom', message })
}
