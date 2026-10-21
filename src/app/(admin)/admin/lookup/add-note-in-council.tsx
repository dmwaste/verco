'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setCurrentAdminClient } from '@/lib/admin/actions'
import { staleActionMessage } from '@/lib/bundle/stale-action'

/**
 * "Add a note" for a caller's property in another council than the switcher's
 * (VER-321). The property page opens only properties in the switcher's council
 * (VER-281), so this switches to the property's council — the same validated
 * write the top-bar switcher makes — then opens the property.
 */
export function AddNoteInCouncil({
  propertyId,
  clientId,
  clientName,
}: {
  propertyId: string
  clientId: string
  clientName: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function open() {
    setError(null)
    startTransition(async () => {
      try {
        const result = await setCurrentAdminClient(clientId)
        if (!result.ok) {
          setError(result.error)
          return
        }
        router.push(`/admin/properties/${propertyId}`)
      } catch (e) {
        setError(staleActionMessage(e) ?? `Couldn't switch to ${clientName}. Please try again.`)
      }
    })
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={open}
        disabled={isPending}
        className="text-body-sm font-semibold text-[#293F52] hover:underline disabled:opacity-50"
      >
        {isPending ? 'Opening…' : 'Add a note'}
        <span className="font-normal text-gray-500"> · switches to {clientName}</span>
      </button>
      {error && (
        <p role="alert" className="text-xs text-status-error">
          {error}
        </p>
      )}
    </div>
  )
}
