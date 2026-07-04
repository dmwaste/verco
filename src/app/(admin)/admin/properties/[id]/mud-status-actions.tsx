'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Dialog } from '@base-ui/react/dialog'
import { markMudRegistered, markMudInactive, reactivateMud } from '../actions'
import { canMarkRegistered } from '@/lib/mud/state-machine'

interface MudStatusActionsProps {
  property: {
    id: string
    is_mud: boolean
    unit_count: number
    strata_contact_id: string | null
    auth_form_url: string | null
    waste_location_notes: string | null
    collection_cadence: string | null
    mud_onboarding_status: 'Contact Made' | 'Registered' | 'Inactive' | null
  }
}

export function MudStatusActions({ property }: MudStatusActionsProps) {
  const router = useRouter()
  const [showInactiveDialog, setShowInactiveDialog] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Local prereq check for the disabled-state UI hint. The server re-validates
  // before transitioning, so this is purely informational.
  const prereq = canMarkRegistered({
    is_mud: property.is_mud,
    unit_count: property.unit_count,
    strata_contact_id: property.strata_contact_id,
    auth_form_url: property.auth_form_url,
    waste_location_notes: property.waste_location_notes,
    collection_cadence: property.collection_cadence,
  })

  async function handleMarkRegistered() {
    setError(null)
    setIsSubmitting(true)
    try {
      const result = await markMudRegistered(property.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.refresh()
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleMarkInactive() {
    setError(null)
    setIsSubmitting(true)
    try {
      const result = await markMudInactive(property.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setShowInactiveDialog(false)
      router.refresh()
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleReactivate() {
    setError(null)
    setIsSubmitting(true)
    try {
      const result = await reactivateMud(property.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.refresh()
    } finally {
      setIsSubmitting(false)
    }
  }

  const status = property.mud_onboarding_status

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {status === 'Contact Made' && (
        <>
          <button
            type="button"
            onClick={handleMarkRegistered}
            disabled={!prereq.ok || isSubmitting}
            className="w-full rounded-xl bg-emerald-600 px-3.5 py-2.5 text-body-sm font-semibold text-white disabled:opacity-50"
          >
            {isSubmitting ? 'Marking...' : 'Mark as Registered'}
          </button>
          {!prereq.ok && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-caption text-amber-800">
              <div className="font-semibold">Cannot mark Registered yet:</div>
              <ul className="mt-1 list-disc pl-4">
                {prereq.errors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {status === 'Registered' && (
        <>
          <Link
            href={`/admin/properties/${property.id}/book`}
            className="block w-full rounded-xl bg-[#00E47C] px-3.5 py-2.5 text-center text-body-sm font-semibold text-[#293F52]"
          >
            Create booking
          </Link>
          <button
            type="button"
            onClick={() => setShowInactiveDialog(true)}
            disabled={isSubmitting}
            className="w-full rounded-xl border-[1.5px] border-red-200 bg-white px-3.5 py-2.5 text-body-sm font-semibold text-red-700 hover:bg-red-50"
          >
            Mark Inactive
          </button>
        </>
      )}

      {status === 'Inactive' && (
        <button
          type="button"
          onClick={handleReactivate}
          disabled={isSubmitting}
          className="w-full rounded-xl bg-emerald-600 px-3.5 py-2.5 text-body-sm font-semibold text-white disabled:opacity-50"
        >
          {isSubmitting ? 'Reactivating...' : 'Reactivate'}
        </button>
      )}

      {/* Mark Inactive confirmation */}
      <Dialog.Root open={showInactiveDialog} onOpenChange={setShowInactiveDialog}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
              <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
                Mark MUD Inactive
              </Dialog.Title>
              <p className="mt-1.5 text-body-sm leading-relaxed text-gray-500">
                Inactive MUDs are not bookable. Existing bookings are not affected. The record
                stays in the system and can be reactivated later — no re-onboarding required.
              </p>
              <div className="mt-5 flex gap-2.5">
                <Dialog.Close
                  className="flex-1 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-3 text-body-sm font-semibold text-[#293F52]"
                  disabled={isSubmitting}
                >
                  Cancel
                </Dialog.Close>
                <button
                  type="button"
                  onClick={handleMarkInactive}
                  disabled={isSubmitting}
                  className="flex-1 rounded-xl bg-red-600 px-3.5 py-3 text-body-sm font-semibold text-white disabled:opacity-50"
                >
                  {isSubmitting ? 'Marking...' : 'Confirm Inactive'}
                </button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
