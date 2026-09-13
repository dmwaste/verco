'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { checkBundleFreshness } from '@/lib/bundle/reload-if-stale'

/**
 * Mounted once per long-lived surface (field + admin layouts). A soft
 * navigation is a safe moment to swap a stale bundle for the deployed one —
 * nothing has been typed on the new page yet — so the /api/health SHA check
 * runs there (throttled in the lib) rather than on focus, which could reload
 * a half-filled closeout or booking form. The run sheet keeps its own
 * focus-time check (`useRefreshOnFocus`) because it holds no form state.
 */
export function BundleFreshness() {
  const pathname = usePathname()
  useEffect(() => {
    void checkBundleFreshness()
  }, [pathname])
  return null
}
