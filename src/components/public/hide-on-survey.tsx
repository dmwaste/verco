'use client'

import { usePathname } from 'next/navigation'

/**
 * Hides the resident app chrome (top nav, bottom tab bar, FAB) on the public
 * survey pages. A survey is opened from an emailed link by a logged-out
 * resident, so the app navigation doesn't apply and the bottom bar/FAB overlap
 * the standalone survey card. `usePathname` resolves during SSR too, so the
 * chrome never appears in the initial HTML (no hydration flash).
 */
export function HideOnSurvey({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  if (pathname?.startsWith('/survey')) return null
  return <>{children}</>
}
