// Source of truth for the T&Cs "has terms" predicate + acceptance channel type.
// Mirrored to src/lib/booking/terms.ts by scripts/sync-mirrors.sh (no imports, so the
// two files are byte-identical). Edit HERE, then run sync-mirrors.sh.

export type TermsAcceptanceChannel = 'resident_self' | 'staff_on_behalf' | 'mud_admin'

/**
 * Whether a client has Terms & Conditions configured. Must match the SQL predicate
 * `terms_markdown ~ '\S'` exactly (any non-whitespace char). Empty/whitespace-only
 * markdown means "no terms" — the booking gate is skipped. NEVER use a spaces-only
 * trim: JS `.trim()` strips tabs/newlines too, matching the SQL.
 */
export function clientHasTerms(markdown: string | null | undefined): boolean {
  return (markdown ?? '').trim().length > 0
}
