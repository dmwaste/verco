'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setCurrentAdminClient } from '@/lib/admin/actions'

interface ClientSwitcherProps {
  current: { id: string; name: string }
  accessible: Array<{ id: string; name: string }>
}

/**
 * Tenant pill in the admin top bar. Single-client users see a static pill
 * (matches the old admin-layout-client.tsx visual). Users with access to
 * 2+ clients get a dropdown that writes the choice to the
 * `verco_admin_client` cookie and refreshes the layout.
 */
export function ClientSwitcher({ current, accessible }: ClientSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  const hasMultiple = accessible.length > 1

  if (!hasMultiple) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 text-body-sm font-medium text-white">
        <div className="size-2 rounded-full bg-[#00E47C]" />
        {current.name}
      </div>
    )
  }

  function handleSelect(clientId: string) {
    if (clientId === current.id) {
      setOpen(false)
      return
    }
    startTransition(async () => {
      const result = await setCurrentAdminClient(clientId)
      if (result.ok) {
        router.refresh()
      }
      setOpen(false)
    })
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={isPending}
        className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 text-body-sm font-medium text-white transition-colors hover:bg-white/15 disabled:opacity-60"
      >
        <div className="size-2 rounded-full bg-[#00E47C]" />
        {current.name}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-70"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Close switcher"
          />
          <div className="absolute left-0 top-full z-50 mt-1.5 min-w-[220px] overflow-hidden rounded-lg bg-white shadow-lg ring-1 ring-black/5">
            <div className="border-b border-gray-100 px-3 py-2 text-caption font-semibold uppercase tracking-wide text-gray-400">
              Switch client
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {accessible.map((c) => {
                const isCurrent = c.id === current.id
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => handleSelect(c.id)}
                    disabled={isPending}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-body-sm transition-colors hover:bg-gray-50 disabled:opacity-60 ${
                      isCurrent ? 'bg-gray-50 font-semibold text-[#293F52]' : 'text-gray-700'
                    }`}
                  >
                    <span>{c.name}</span>
                    {isCurrent && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#00B864"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
