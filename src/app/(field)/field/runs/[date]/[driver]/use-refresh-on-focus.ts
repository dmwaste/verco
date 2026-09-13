'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { checkBundleFreshness } from '@/lib/bundle/reload-if-stale'

// Crew phones keep the run sheet open for days, so a deploy leaves them on a
// bundle the new server no longer matches — server-action calls then fail or
// arrive with pre-deploy arguments (03/08/2026: every VV bulk closeout was
// rejected by a gate the stale bundle couldn't satisfy). On focus we compare
// the bundle's build-time SHA against the running server's (/api/health, ADR
// 0010) and hard-reload once on mismatch — `checkBundleFreshness`, shared
// with the per-navigation check every field/admin surface runs (ADR 0023).
// This hook only runs on the run sheet, which holds no form state, so a
// focus-time reload can't lose crew input.

/**
 * Re-fetches server-component data when the app regains focus — crews bounce
 * to Google Maps and back constantly, and the run sheet must reflect closeouts
 * made in the meantime. Throttled so rapid focus flapping (notification
 * shade, app switcher) doesn't hammer the server. Also swaps a stale app
 * bundle for the deployed one (see checkBundleFreshness).
 */
export function useRefreshOnFocus(throttleMs = 15_000) {
  const router = useRouter()
  const lastRefresh = useRef(0)

  useEffect(() => {
    function onFocus() {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastRefresh.current < throttleMs) return
      lastRefresh.current = now
      router.refresh()
      void checkBundleFreshness()
    }
    // Check the bundle on mount too — a phone reopening the PWA may render
    // from its cached bundle without ever firing a focus event. Data is
    // already fresh from the RSC render, so no router.refresh() here.
    void checkBundleFreshness()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [router, throttleMs])
}
