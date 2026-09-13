'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

// Crew phones keep the run sheet open for days, so a deploy leaves them on a
// bundle the new server no longer matches — server-action calls then fail or
// arrive with pre-deploy arguments (03/08/2026: every VV bulk closeout was
// rejected by a gate the stale bundle couldn't satisfy). On focus we compare
// the bundle's build-time SHA against the running server's (/api/health, ADR
// 0010) and hard-reload once on mismatch. This hook only runs on the run
// sheet, which holds no form state, so the reload can't lose crew input.
const BUNDLE_SHA = process.env.NEXT_PUBLIC_GIT_SHA
const SHA_CHECK_THROTTLE_MS = 5 * 60_000
const RELOADED_FOR_KEY = 'verco-reloaded-for-sha'

async function reloadIfBundleStale(): Promise<void> {
  if (!BUNDLE_SHA) return // dev / non-release build — nothing to compare
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    const { sha } = (await res.json()) as { sha?: string }
    if (!sha || sha === 'unknown' || sha === BUNDLE_SHA) return
    // One attempt per server SHA — if a reload somehow still mismatches
    // (rolling deploy mid-flight), don't loop the crew's phone.
    if (sessionStorage.getItem(RELOADED_FOR_KEY) === sha) return
    sessionStorage.setItem(RELOADED_FOR_KEY, sha)
    window.location.reload()
  } catch {
    // Offline / flaky signal — the next focus retries.
  }
}

/**
 * Re-fetches server-component data when the app regains focus — crews bounce
 * to Google Maps and back constantly, and the run sheet must reflect closeouts
 * made in the meantime. Throttled so rapid focus flapping (notification
 * shade, app switcher) doesn't hammer the server. Also swaps a stale app
 * bundle for the deployed one (see reloadIfBundleStale above).
 */
export function useRefreshOnFocus(throttleMs = 15_000) {
  const router = useRouter()
  const lastRefresh = useRef(0)
  const lastShaCheck = useRef(0)

  useEffect(() => {
    function onFocus() {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastRefresh.current < throttleMs) return
      lastRefresh.current = now
      router.refresh()
      if (now - lastShaCheck.current >= SHA_CHECK_THROTTLE_MS) {
        lastShaCheck.current = now
        void reloadIfBundleStale()
      }
    }
    // Check the bundle on mount too — a phone reopening the PWA may render
    // from its cached bundle without ever firing a focus event. Data is
    // already fresh from the RSC render, so no router.refresh() here.
    lastShaCheck.current = Date.now()
    void reloadIfBundleStale()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [router, throttleMs])
}
