'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { openInvestigation } from '@/lib/exceptions/actions'

/**
 * Staff "open an investigation on behalf of a resident" — advances an Issued /
 * Disputed notice to Under Review. Render only for staff on those statuses.
 * Invalidates the exception table query (immediate row refresh) and refreshes
 * the server tree so the sidebar badge + dashboard reflect the new open count.
 */
export function OpenInvestigationButton({
  kind,
  noticeId,
}: {
  kind: 'ncn' | 'np'
  noticeId: string
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function handleClick(e: React.MouseEvent) {
    // Rows are wrapped in links elsewhere; keep the click on the button.
    e.preventDefault()
    e.stopPropagation()
    setError(null)
    const res = await openInvestigation({ kind, noticeId })
    if (!res.ok) {
      setError(res.error)
      return
    }
    await queryClient.invalidateQueries({
      queryKey: [kind === 'ncn' ? 'admin-ncn' : 'admin-np'],
    })
    startTransition(() => router.refresh())
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="inline-flex items-center rounded-md border-[1.5px] border-[#293F52] bg-white px-3 py-1 text-xs font-semibold text-[#293F52] hover:bg-[#293F52]/5 disabled:opacity-50"
      >
        {pending ? 'Opening…' : 'Open investigation'}
      </button>
      {error && <span className="max-w-[160px] text-2xs text-status-error">{error}</span>}
    </span>
  )
}
