'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Top-bar search. On Enter, navigates to `/admin/bookings?search=<query>`.
 * The bookings list filters by booking ref, property formatted_address, and
 * contact full_name (pre-fetch + .or() pattern — see bookings-list-client).
 *
 * Future scope: also surface non-booking matches (e.g. properties without
 * bookings, tickets) — would need a server-side multi-table search RPC.
 */
export function AdminSearchBar() {
  const router = useRouter()
  const [value, setValue] = useState('')

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) {
      router.push('/admin/bookings')
      return
    }
    const params = new URLSearchParams({ search: trimmed })
    router.push(`/admin/bookings?${params.toString()}`)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex w-60 items-center gap-2 rounded-lg bg-white/10 px-3.5 py-1.5 text-body-sm text-white transition-colors focus-within:bg-white/15"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 opacity-60"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search ref, address, name..."
        className="w-full bg-transparent text-body-sm text-white outline-none placeholder:text-white/60"
      />
    </form>
  )
}
