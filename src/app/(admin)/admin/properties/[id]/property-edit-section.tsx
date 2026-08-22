'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { invokeEfWithUserToken } from '@/lib/supabase/invoke-ef-client'
import { canMoveArea, moveAreaMessage } from '@/lib/properties/edit-rules'
import type { Database } from '@/lib/supabase/types'

type AppRole = Database['public']['Enums']['app_role']
import { FieldLabel, Input, Select } from '@/components/admin/form'
import { moveEligiblePropertyArea, updateEligiblePropertyAddress } from '../actions'

/**
 * In-place property edits (#502 / BR-0034). Replaces the "mark ineligible +
 * recreate" workaround that orphaned bookings/allocations and reset the FY
 * allocation. Address: any admin role, auto re-geocoded. Area move:
 * contractor-only, blocked while non-terminal bookings exist — the server
 * action is the authority; this component only mirrors the gate for the UI.
 */
interface PropertyEditSectionProps {
  property: {
    id: string
    address: string
    formatted_address: string | null
    has_geocode: boolean
    collection_area_id: string | null
    collection_area: { id: string; name: string; code: string }
  }
  areas: Array<{ id: string; name: string; code: string }>
  bookingStatuses: string[]
  role: AppRole | null
}

export function PropertyEditSection({ property, areas, bookingStatuses, role }: PropertyEditSectionProps) {
  const router = useRouter()
  const supabase = createClient()
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState(property.address)
  const [areaId, setAreaId] = useState(property.collection_area_id ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const moveDecision = canMoveArea(role, bookingStatuses)
  const canMove = moveDecision.ok

  function cancel() {
    setEditing(false)
    setAddress(property.address)
    setAreaId(property.collection_area_id ?? '')
    setError(null)
  }

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const addressChanged = address.trim() !== property.address
      const areaChanged = canMove && areaId && areaId !== property.collection_area_id

      if (addressChanged) {
        const r = await updateEligiblePropertyAddress({ property_id: property.id, address })
        if (!r.ok) { setError(r.error); return }
        if (r.data.changed) {
          // Re-geocode just this row. Failure here is non-fatal: the address is
          // saved and the row is picked up by the next list-page Geocode run.
          const geo = await invokeEfWithUserToken<{ processed?: number; failed?: number }>(
            supabase, 'geocode-properties', { property_ids: [property.id] },
          )
          if (!geo.ok || (geo.data.failed ?? 0) > 0) {
            setNotice('Address saved. Geocoding did not complete — use Geocode on the properties list to retry.')
          }
        }
      }
      if (areaChanged) {
        const r = await moveEligiblePropertyArea({ property_id: property.id, collection_area_id: areaId })
        if (!r.ok) { setError(r.error); return }
      }
      setEditing(false)
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl bg-white shadow-sm">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <h2 className="font-[family-name:var(--font-heading)] text-body font-bold text-[#293F52]">
          Property details
        </h2>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-body-sm font-medium text-[#293F52] hover:bg-gray-50"
          >
            Edit
          </button>
        )}
      </div>

      {!editing ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-5 pb-5 text-body-sm md:grid-cols-2">
          <div>
            <dt className="text-caption text-gray-500">Address</dt>
            <dd className="text-gray-900">{property.address}</dd>
            {property.formatted_address && property.formatted_address !== property.address && (
              <dd className="text-xs text-gray-500">Geocoded as: {property.formatted_address}</dd>
            )}
            {!property.has_geocode && (
              <dd className="text-xs text-status-warn">Not yet geocoded</dd>
            )}
          </div>
          <div>
            <dt className="text-caption text-gray-500">Collection area</dt>
            <dd className="text-gray-900">{property.collection_area.code} — {property.collection_area.name}</dd>
          </div>
          {notice && <dd className="md:col-span-2 text-xs text-status-warn">{notice}</dd>}
        </dl>
      ) : (
        <form
          className="space-y-4 px-5 pb-5"
          onSubmit={(e) => { e.preventDefault(); void save() }}
        >
          <div>
            <FieldLabel htmlFor="prop-address">Address</FieldLabel>
            <Input
              id="prop-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              required
              minLength={3}
              maxLength={500}
            />
            <p className="mt-1 text-xs text-gray-500">
              Changing the address re-geocodes the property automatically. Bookings and allocations stay attached.
            </p>
          </div>

          <div>
            <FieldLabel htmlFor="prop-area">Collection area</FieldLabel>
            <Select
              id="prop-area"
              value={areaId}
              onChange={(e) => setAreaId(e.target.value)}
              disabled={!canMove}
            >
              {areas.map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
              ))}
            </Select>
            {!moveDecision.ok && (
              <p className="mt-1 text-xs text-gray-500">{moveAreaMessage(moveDecision)}</p>
            )}
          </div>

          {error && (
            <p className="rounded-lg bg-status-error-bg px-3 py-2 text-body-sm text-status-error">{error}</p>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="rounded-lg border border-gray-200 px-4 py-2 text-body-sm font-medium text-[#293F52]"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
