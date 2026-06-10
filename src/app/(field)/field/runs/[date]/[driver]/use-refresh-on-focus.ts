'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Re-fetches server-component data when the app regains focus — crews bounce
 * to Google Maps and back constantly, and the run sheet must reflect closeouts
 * made in the meantime. Throttled so rapid focus flapping (notification
 * shade, app switcher) doesn't hammer the server.
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
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [router, throttleMs])
}
