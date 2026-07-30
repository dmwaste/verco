import Link from 'next/link'
import { SignOutButton } from '@/components/auth/sign-out-button'
import { VercoLogo } from '@/components/branding/verco-logo'

interface OnBehalfBarProps {
  /** Name of the client the staff user is acting as, or null if unresolved. */
  clientName: string | null
}

/**
 * Slim operator bar for the staff "act on behalf of a resident" flows
 * (`/book`, `/survey`) on `admin.verco.au`.
 *
 * The `(public)` layout renders a chrome-less shell on contractor hosts because
 * it also wraps `/auth` there, where a resident nav would be wrong. `/book`
 * inherited that shell, so staff entering the booking wizard lost the Verco
 * lockup, the tenant indicator, the route back to `/admin`, and sign-out.
 *
 * The tenant name is deliberately READ-ONLY here — no ClientSwitcher. The
 * wizard threads `property_id` / `collection_area_id` through its URL between
 * steps, so switching tenant mid-flow would leave those params pointing at the
 * previous client's rows. Staff switch client on `/admin` before starting.
 *
 * Showing which client is being acted as is the guardrail for the wrong-tenant
 * class of bug: an on-behalf booking that silently resolves to the wrong
 * council is otherwise invisible until the resident is told they're ineligible.
 *
 * Operator host ⇒ Verco branding, never tenant branding (memory
 * verco-logo-vs-tenant-branding).
 */
export function OnBehalfBar({ clientName }: OnBehalfBarProps) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 bg-[#293F52] px-4 print:hidden sm:gap-3 sm:px-5">
      {/* Wordmark is dropped below sm so the tenant name keeps the width it
          needs — the name is the load-bearing element here, not the logo. */}
      <Link
        href="/admin"
        aria-label="Verco admin home"
        className="flex shrink-0 items-center"
      >
        <VercoLogo
          variant="reversed"
          iconClassName="size-8 shrink-0"
          wordmarkClassName="hidden text-base sm:inline"
          className="gap-2.5"
        />
      </Link>

      {clientName && (
        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 text-body-sm font-medium text-white">
          <div className="size-2 shrink-0 rounded-full bg-[#00E47C]" />
          <span className="hidden shrink-0 text-[#8FA5B8] sm:inline">Acting as</span>
          <span className="truncate">{clientName}</span>
        </div>
      )}

      <div className="min-w-0 flex-1" />

      {/* Shortens to "← Admin" on phones — a bare arrow next to "Sign out"
          reads as though it belongs to it. aria-label carries the full text. */}
      <Link
        href="/admin"
        aria-label="Back to admin"
        className="shrink-0 whitespace-nowrap text-body-sm font-medium text-[#8FA5B8] transition-colors hover:text-white"
      >
        <span aria-hidden="true">&larr;</span>
        <span aria-hidden="true" className="sm:hidden"> Admin</span>
        <span aria-hidden="true" className="hidden sm:inline"> Back to admin</span>
      </Link>
      <SignOutButton
        destination="login"
        className="shrink-0 whitespace-nowrap text-body-sm font-medium text-[#8FA5B8] transition-colors hover:text-white"
      />
    </div>
  )
}
