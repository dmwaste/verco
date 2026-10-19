'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { FieldLabel, Input, Select } from '@/components/admin/form'
import { staleActionMessage } from '@/lib/bundle/stale-action'
import {
  geocodeProperty,
  rejectionExplanation,
  type PropertyGeocodeOutcome,
} from '@/lib/properties/geocode-outcome'
import { createEligibleProperty } from './actions'
import { areaOptionLabel } from './area-option-label'

interface AddPropertyPanelProps {
  areas: Array<{ id: string; code: string; name: string; is_active: boolean }>
  /** Called once the property exists and its map lookup has answered. */
  onAdded: () => void
}

type Step = 'idle' | 'adding' | 'pinning'

/**
 * Add a single eligible property, then look up ITS map pin and wait for the
 * answer. A property with no pin can't go into the crews' OptimoRoute routes,
 * so staff are told on the spot when Google's match is refused or the lookup
 * fails. The panel used to start a background loop over the whole queue that
 * never reported the refusal (a hand-added Kwinana property, 15/10/2026).
 */
export function AddPropertyPanel({ areas, onAdded }: AddPropertyPanelProps) {
  const supabase = createClient()
  const [area, setArea] = useState('')
  const [address, setAddress] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<{ id: string; outcome: PropertyGeocodeOutcome } | null>(null)

  async function handleAdd() {
    if (step !== 'idle') return
    setError(null)
    setAdded(null)

    if (!area) {
      setError('Select a collection area.')
      return
    }
    if (address.trim().length < 5) {
      setError('Enter a full street address.')
      return
    }

    setStep('adding')
    try {
      const result = await createEligibleProperty({ collection_area_id: area, address: address.trim() })
      if (!result.ok) {
        setError(result.error)
        return
      }
      const id = result.data.property_id
      setAddress('')

      setStep('pinning')
      setAdded({ id, outcome: await geocodeProperty(supabase, id) })
      onAdded()
    } catch (err) {
      setError(staleActionMessage(err) ?? 'Couldn’t add the property. Check your connection and try again.')
    } finally {
      setStep('idle')
    }
  }

  const outcome = added?.outcome

  return (
    <div className="mx-7 mt-4 rounded-xl border border-gray-200 bg-white p-5">
      <h3 className="mb-3 text-sm font-semibold text-[#293F52]">Add a single property</h3>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="sm:w-56">
          <FieldLabel htmlFor="add-property-area">Collection area</FieldLabel>
          <Select id="add-property-area" value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">Select area…</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>{areaOptionLabel(a)}</option>
            ))}
          </Select>
        </div>
        <div className="flex-1">
          <FieldLabel htmlFor="add-property-address">Address</FieldLabel>
          <Input
            id="add-property-address"
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd() }}
            placeholder="e.g. 23 Leda Blvd, Wellard WA 6170"
          />
        </div>
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={step !== 'idle'}
          className="rounded-lg bg-[#293F52] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {step === 'adding' ? 'Adding…' : step === 'pinning' ? 'Finding the map pin…' : 'Add'}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-status-error">{error}</p>}
      {added && outcome?.kind === 'pinned' && (
        <p className="mt-2 text-sm text-status-success">Property added and pinned on the map.</p>
      )}
      {added && outcome && outcome.kind !== 'pinned' && (
        <div role="alert" className="mt-2 space-y-1 rounded-lg bg-status-warn-bg px-3 py-2 text-sm text-status-warn">
          <p className="font-semibold">Property added, but it has no map pin.</p>
          <p>
            {outcome.kind === 'rejected'
              ? rejectionExplanation(outcome.google, outcome.reason)
              : `The map lookup didn’t complete (${outcome.error}). Geocode All retries every property without a pin.`}
          </p>
          <p>
            Until it has a pin, its collections can’t go into the crews’ routes.{' '}
            <Link href={`/admin/properties/${added.id}`} className="font-medium underline">
              {outcome.kind === 'rejected' ? 'Fix the address on the property page' : 'Open the property'}
            </Link>
          </p>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-400">
        Added as a residential eligible address. Verco then looks up its map pin and tells you here if
        Google can’t place it. Convert to a MUD later via the row menu.
      </p>
    </div>
  )
}
