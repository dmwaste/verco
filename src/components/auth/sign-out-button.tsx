'use client'

import { signOutAction } from '@/app/(public)/auth/actions'
import type { SignOutDestination } from '@/lib/auth/sign-out'

interface SignOutButtonProps {
  /**
   * Where to land after sign-out:
   *   'login' → /auth   (admin + field surfaces)
   *   'home'  → /       (resident surface)
   * Sent as a hidden field; the server action maps it to a hardcoded path.
   */
  destination: SignOutDestination
  className?: string
  /** Styles the wrapping <form> (e.g. `flex-1` so it sizes like sibling tabs). */
  formClassName?: string
  /** Plain text label (default). Ignored when `children` is provided. */
  label?: string
  /** Custom button content (e.g. icon + label for the mobile tab). */
  children?: React.ReactNode
}

/**
 * Single shared sign-out control used on every surface (admin top bar, field
 * header, resident nav). Posts to the `signOutAction` server action — never a
 * GET route — so it is CSRF-safe and not triggerable by link prefetchers.
 */
export function SignOutButton({ destination, className, formClassName, label = 'Sign out', children }: SignOutButtonProps) {
  return (
    <form action={signOutAction} className={formClassName}>
      <input type="hidden" name="destination" value={destination} />
      <button type="submit" className={className}>
        {children ?? label}
      </button>
    </form>
  )
}
