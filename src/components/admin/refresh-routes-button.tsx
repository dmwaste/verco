'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { refreshRoutes } from '@/lib/optimoroute/refresh-routes'

/**
 * Pulls the latest routing plan from OptimoRoute on demand (contractor staff
 * only — the EF enforces the role server-side too). Inline status text instead
 * of a toast: the result counts are operationally meaningful. On success it
 * refreshes the current page so run sheets / bookings re-render with the new
 * driver + sequence data.
 */
export function RefreshRoutesButton() {
  const router = useRouter()
  const [isPending, setIsPending] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function handleClick() {
    setIsPending(true)
    setStatus(null)
    try {
      const result = await refreshRoutes()
      if (result.ok) {
        setStatus(`✓ ${result.data.routesSeen} routes — ${result.data.stopsStamped} stops updated`)
        router.refresh()
      } else {
        setStatus(result.error)
      }
    } catch {
      setStatus('Route refresh failed — try again.')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {status && <span className="max-w-[260px] truncate text-xs text-gray-500">{status}</span>}
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-1.5 text-body-sm font-semibold text-gray-700 disabled:opacity-50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
        {isPending ? 'Refreshing…' : 'Refresh Routes'}
      </button>
    </div>
  )
}
