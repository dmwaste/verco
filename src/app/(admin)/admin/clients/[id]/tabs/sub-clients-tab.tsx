'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient as createBrowserClient } from '@/lib/supabase/client'
import type { Database } from '@/lib/supabase/types'
import { createSubClient, updateSubClient } from '../../actions'
import { Pill } from '@/components/status-badge'

type Client = Database['public']['Tables']['client']['Row']

interface SubClient {
  id: string
  name: string
  code: string
  is_active: boolean
}

export function SubClientsTab({ client, subClients: initialSubClients }: { client: Client; subClients: SubClient[] }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const supabase = createBrowserClient()

  const [showAddForm, setShowAddForm] = useState(false)
  const [addName, setAddName] = useState('')
  const [addCode, setAddCode] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [addSaving, setAddSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editCode, setEditCode] = useState('')
  const [editError, setEditError] = useState<string | null>(null)

  // Fetch sub_clients and collection_areas separately, then aggregate counts in JS.
  // The earlier embedded `collection_area(count)` syntax silently returned 0 once
  // collection_area gained additional FKs (capacity_pool_id added 2026-05-13), even
  // though the direct sub_client_id FK is unambiguous. A separate query is robust
  // against PostgREST's embedded-resolution edge cases.
  const { data: subClients } = useQuery({
    queryKey: ['admin-sub-clients', client.id],
    queryFn: async () => {
      const [scResp, caResp] = await Promise.all([
        supabase
          .from('sub_client')
          .select('id, name, code, is_active')
          .eq('client_id', client.id)
          .order('code'),
        supabase
          .from('collection_area')
          .select('sub_client_id')
          .eq('client_id', client.id)
          .eq('is_active', true)
          .not('sub_client_id', 'is', null),
      ])

      const countsBySc = new Map<string, number>()
      for (const a of caResp.data ?? []) {
        if (!a.sub_client_id) continue
        countsBySc.set(a.sub_client_id, (countsBySc.get(a.sub_client_id) ?? 0) + 1)
      }

      return (scResp.data ?? []).map((sc) => ({
        ...sc,
        collection_area: [{ count: countsBySc.get(sc.id) ?? 0 }],
      })) as Array<SubClient & { collection_area: { count: number }[] }>
    },
    initialData: initialSubClients.map((sc) => ({ ...sc, collection_area: [{ count: 0 }] })),
  })

  async function handleAdd() {
    setAddSaving(true)
    setAddError(null)
    const result = await createSubClient(client.id, { name: addName, code: addCode })
    setAddSaving(false)
    if (!result.ok) {
      setAddError(result.error)
      return
    }
    setShowAddForm(false)
    setAddName('')
    setAddCode('')
    void queryClient.invalidateQueries({ queryKey: ['admin-sub-clients', client.id] })
    router.refresh()
  }

  function startEdit(sc: SubClient) {
    setEditingId(sc.id)
    setEditName(sc.name)
    setEditCode(sc.code)
    setEditError(null)
  }

  async function saveEdit() {
    if (!editingId) return
    setEditError(null)
    const result = await updateSubClient(editingId, { name: editName, code: editCode })
    if (!result.ok) {
      setEditError(result.error)
      return
    }
    setEditingId(null)
    void queryClient.invalidateQueries({ queryKey: ['admin-sub-clients', client.id] })
    router.refresh()
  }

  async function toggleActive(sc: SubClient) {
    await updateSubClient(sc.id, { is_active: !sc.is_active })
    void queryClient.invalidateQueries({ queryKey: ['admin-sub-clients', client.id] })
    router.refresh()
  }

  const inputClass = 'rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2 text-body-sm text-gray-900 outline-none focus:border-[#293F52] focus:bg-white'

  return (
    <div className="max-w-2xl">
      <div className="mb-2 text-2xs text-gray-400">
        Sub-clients are optional. Used when a client manages collections for multiple councils.
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-gray-400">Name</th>
              <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-gray-400">Code</th>
              <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-gray-400">Areas</th>
              <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-gray-400">Status</th>
              <th className="px-4 py-3 text-right text-caption font-semibold uppercase tracking-wider text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody>
            {showAddForm && (
              <tr className="border-b border-gray-50 bg-blue-50/30">
                <td className="px-4 py-2"><input type="text" value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="Name" className={inputClass} /></td>
                <td className="px-4 py-2"><input type="text" value={addCode} onChange={(e) => setAddCode(e.target.value)} placeholder="Code" className={`${inputClass} font-mono`} /></td>
                <td className="px-4 py-2 text-body-sm text-gray-400">&mdash;</td>
                <td className="px-4 py-2 text-body-sm text-gray-400">New</td>
                <td className="px-4 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={handleAdd} disabled={addSaving || !addName || !addCode} className="rounded bg-[#293F52] px-3 py-1 text-2xs font-semibold text-white disabled:opacity-50">
                      {addSaving ? '...' : 'Save'}
                    </button>
                    <button type="button" onClick={() => { setShowAddForm(false); setAddError(null) }} className="rounded border border-gray-200 px-3 py-1 text-2xs text-gray-600">Cancel</button>
                  </div>
                  {addError && <p className="mt-1 text-2xs text-red-500">{addError}</p>}
                </td>
              </tr>
            )}
            {subClients.length === 0 && !showAddForm && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-body-sm text-gray-400">No sub-clients configured</td></tr>
            )}
            {subClients.map((sc) => {
              const areaCount = (sc.collection_area as unknown as { count: number }[])?.[0]?.count ?? 0
              const isEditing = editingId === sc.id

              return (
                <tr key={sc.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-3 text-body-sm font-medium text-[#293F52]">
                    {isEditing ? <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className={inputClass} /> : sc.name}
                  </td>
                  <td className="px-4 py-3 font-mono text-body-sm text-gray-600">
                    {isEditing ? <input type="text" value={editCode} onChange={(e) => setEditCode(e.target.value)} className={`${inputClass} font-mono`} /> : sc.code}
                  </td>
                  <td className="px-4 py-3 text-body-sm text-gray-600">
                    {areaCount === 0 ? (
                      <Pill tone="warn">No areas</Pill>
                    ) : areaCount}
                  </td>
                  <td className="px-4 py-3">
                    <Pill tone={sc.is_active ? 'success' : 'neutral'}>
                      {sc.is_active ? 'Active' : 'Inactive'}
                    </Pill>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isEditing ? (
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={saveEdit} className="rounded bg-[#293F52] px-3 py-1 text-2xs font-semibold text-white">Save</button>
                        <button type="button" onClick={() => setEditingId(null)} className="rounded border border-gray-200 px-3 py-1 text-2xs text-gray-600">Cancel</button>
                        {editError && <p className="text-2xs text-red-500">{editError}</p>}
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => startEdit(sc)} className="text-2xs text-gray-500 hover:text-[#293F52]">Edit</button>
                        <button type="button" onClick={() => toggleActive(sc)} className="text-2xs text-gray-500 hover:text-[#293F52]">
                          {sc.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {!showAddForm && (
        <button
          type="button"
          onClick={() => setShowAddForm(true)}
          className="mt-3 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white"
        >
          + Add Sub-Client
        </button>
      )}
    </div>
  )
}
