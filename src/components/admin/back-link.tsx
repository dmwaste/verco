import Link from 'next/link'

/**
 * Canonical back-link for admin detail pages (chevron + body-sm, the
 * NCN/NP/ticket variant) — replaces the four competing hand-rolled styles.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mb-2.5 flex items-center gap-1.5 text-body-sm font-medium text-[#8FA5B8] hover:text-[#293F52]"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      {label}
    </Link>
  )
}
