'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient as createBrowserClient } from '@/lib/supabase/client'
import type { Database } from '@/lib/supabase/types'
import { createCollectionArea, updateCollectionArea } from '../../actions'

type Client = Database['public']['Tables']['client']['Row']

interface SubClient { id: string; name: string; code: string; is_active: boolean }

export function CollectionAreasTab({ client, subClients }: { client: Client; subClients: SubClient[] }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const supabase = createBrowserClient()

  const [showAddForm, setShowAddForm] = useState(false)
  const [addCode, setAddCode] = useState('')
  const [addName, setAddName] = useState('')
  const [addSubClientId, setAddSubClientId] = useState('')
  const [addDmJobCode, setAddDmJobCode] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [addSaving, setAddSaving] = useState(false)

  const { data: areas } = useQuery({
    queryKey: ['admin-collection-areas', client.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('collection_area')
        .select('id, code, name, sub_client_id, dm_job_code, is_active, eligible_properties(count)')
        .eq('client_id', client.id)
        .order('code')
      return data ?? []
    },
  })

  async function handleAdd() {
    setAddSaving(true)
    setAddError(null)
    const result = await createCollectionArea(client.id, {
      code: addCode,
      name: addName,
      sub_client_id: addSubClientId || null,
      dm_job_code: addDmJobCode || null,
    })
    setAddSaving(false)
    if (!result.ok) {
      setAddError(result.error)
      return
    }
    setShowAddForm(false)
    setAddCode('')
    setAddName('')
    setAddSubClientId('')
    setAddDmJobCode('')
    void queryClient.invalidateQueries({ queryKey: ['admin-collection-areas', client.id] })
    router.refresh()
  }

  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  // Staged go-live toggle (WS-A / VER-269): flip a collection area's is_active to
  // bring it live on the new system or hold it back. The booking gate (lookup +
  // capacity RPC + RLS) reads this flag.
  async function handleToggleActive(area: { id: string; code: string; is_active: boolean }) {
    const goingLive = !area.is_active
    const confirmed = window.confirm(
      goingLive
        ? `Make ${area.code} bookable on the new system? Residents will be able to book straight away.`
        : `Take ${area.code} offline? Residents will see "not yet available" instead of booking.`
    )
    if (!confirmed) return
    setTogglingId(area.id)
    setToggleError(null)
    const result = await updateCollectionArea(area.id, { is_active: goingLive })
    setTogglingId(null)
    if (!result.ok) {
      setToggleError(`${area.code}: ${result.error}`)
      return
    }
    void queryClient.invalidateQueries({ queryKey: ['admin-collection-areas', client.id] })
    router.refresh()
  }

  const inputClass = 'rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2 text-body-sm text-gray-900 outline-none focus:border-[#293F52] focus:bg-white'

  return (
    <div className="max-w-4xl">
      <div className="mb-2 text-2xs text-gray-400">
        Collection areas define geographic zones. Allocation and service rules are configured in the Rules tab and apply to all areas. Toggle a row&rsquo;s status to bring it live on the new booking system or hold it back.
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-gray-400">Code</th>
              <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-gray-400">Name</th>
              <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-gray-400">Sub-Client</th>
              <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-gray-400">Properties</th>
              <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-gray-400">DM Job Code</th>
              <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-gray-400">Status</th>
            </tr>
          </thead>
          <tbody>
            {showAddForm && (
              <tr className="border-b border-gray-50 bg-blue-50/30">
                <td className="px-4 py-2"><input type="text" value={addCode} onChange={(e) => setAddCode(e.target.value)} placeholder="Code" className={`${inputClass} w-24 font-mono`} /></td>
                <td className="px-4 py-2"><input type="text" value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="Name" className={inputClass} /></td>
                <td className="px-4 py-2">
                  <select value={addSubClientId} onChange={(e) => setAddSubClientId(e.target.value)} className={inputClass}>
                    <option value="">None</option>
                    {subClients.filter((sc) => sc.is_active).map((sc) => (
                      <option key={sc.id} value={sc.id}>{sc.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2 text-body-sm text-gray-400">&mdash;</td>
                <td className="px-4 py-2"><input type="text" value={addDmJobCode} onChange={(e) => setAddDmJobCode(e.target.value)} placeholder="Optional" className={`${inputClass} w-24 font-mono`} /></td>
                <td className="px-4 py-2">
                  <div className="flex gap-2">
                    <button type="button" onClick={handleAdd} disabled={addSaving || !addCode || !addName} className="rounded bg-[#293F52] px-3 py-1 text-2xs font-semibold text-white disabled:opacity-50">
                      {addSaving ? '...' : 'Save'}
                    </button>
                    <button type="button" onClick={() => { setShowAddForm(false); setAddError(null) }} className="rounded border border-gray-200 px-3 py-1 text-2xs text-gray-600">Cancel</button>
                  </div>
                  {addError && <p className="mt-1 text-2xs text-red-500">{addError}</p>}
                </td>
              </tr>
            )}
            {(!areas || areas.length === 0) && !showAddForm && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-body-sm text-gray-400">No collection areas configured</td></tr>
            )}
            {(areas ?? []).map((area) => {
              const subClient = subClients.find((sc) => sc.id === area.sub_client_id)
              const propCount = (area.eligible_properties as unknown as { count: number }[])?.[0]?.count ?? 0

              return (
                <tr key={area.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-3 font-mono text-body-sm font-semibold text-[#293F52]">{area.code}</td>
                  <td className="px-4 py-3 text-body-sm text-gray-600">{area.name}</td>
                  <td className="px-4 py-3 text-body-sm text-gray-400">{subClient?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-body-sm text-gray-600">{propCount.toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono text-body-sm text-gray-400">{area.dm_job_code ?? '—'}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(area)}
                      disabled={togglingId === area.id}
                      title={area.is_active ? 'Live on the new system — click to hold back' : 'Held back — click to make bookable'}
                      className={`rounded-full px-2 py-0.5 text-2xs font-semibold transition hover:brightness-95 disabled:opacity-50 ${area.is_active ? 'bg-status-success-bg text-status-success' : 'bg-gray-100 text-gray-500'}`}
                    >
                      {togglingId === area.id ? '…' : area.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {toggleError && <p className="mt-2 text-2xs text-red-500">{toggleError}</p>}

      {!showAddForm && (
        <button
          type="button"
          onClick={() => setShowAddForm(true)}
          className="mt-3 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white"
        >
          + Add Area
        </button>
      )}
    </div>
  )
}
