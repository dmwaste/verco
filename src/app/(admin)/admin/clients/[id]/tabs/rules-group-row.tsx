'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient as createBrowserClient } from '@/lib/supabase/client'
import { upsertAllocationRules, upsertServiceRules } from '../../actions'

interface Category { id: string; name: string; code: string }
interface Service { id: string; name: string; category_id: string }

export interface RulesGroup {
  key: string
  label: string
  kind: 'sub-client' | 'area'
  areas: Array<{ id: string; code: string }>
}

interface AllocRuleRow {
  collection_area_id: string
  category_id: string
  max_collections: number
}

interface SvcRuleRow {
  collection_area_id: string
  service_id: string
  max_collections: number
  extra_unit_price: number
}

/**
 * Detects whether all areas in a group share the same rules. Used to flag
 * heterogeneity so the admin knows that saving will overwrite per-area
 * customisations.
 */
function detectHeterogeneity(
  areas: Array<{ id: string }>,
  alloc: AllocRuleRow[],
  svc: SvcRuleRow[],
): boolean {
  if (areas.length <= 1) return false

  const allocByArea = new Map<string, Map<string, number>>()
  for (const a of areas) allocByArea.set(a.id, new Map())
  for (const r of alloc) allocByArea.get(r.collection_area_id)?.set(r.category_id, r.max_collections)

  const svcByArea = new Map<string, Map<string, { max: number; price: number }>>()
  for (const a of areas) svcByArea.set(a.id, new Map())
  for (const r of svc) svcByArea.get(r.collection_area_id)?.set(r.service_id, { max: r.max_collections, price: Number(r.extra_unit_price) })

  const firstAllocStr = JSON.stringify(Array.from(allocByArea.get(areas[0]!.id)!.entries()).sort())
  const firstSvcStr = JSON.stringify(Array.from(svcByArea.get(areas[0]!.id)!.entries()).sort())
  for (let i = 1; i < areas.length; i++) {
    const a = areas[i]!
    const allocStr = JSON.stringify(Array.from(allocByArea.get(a.id)!.entries()).sort())
    const svcStr = JSON.stringify(Array.from(svcByArea.get(a.id)!.entries()).sort())
    if (allocStr !== firstAllocStr || svcStr !== firstSvcStr) return true
  }
  return false
}

interface RulesGroupRowProps {
  group: RulesGroup
  categories: Category[]
  services: Service[]
}

export function RulesGroupRow({ group, categories, services }: RulesGroupRowProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const supabase = createBrowserClient()

  const areaIds = useMemo(() => group.areas.map((a) => a.id), [group.areas])
  const firstAreaId = group.areas[0]?.id ?? null

  // Fetch rules for all areas in the group (for heterogeneity check + template values).
  const { data: rules, isLoading } = useQuery({
    queryKey: ['rules-group', group.key, areaIds.join(',')],
    enabled: areaIds.length > 0,
    queryFn: async () => {
      const [allocResp, svcResp] = await Promise.all([
        supabase
          .from('allocation_rules')
          .select('collection_area_id, category_id, max_collections')
          .in('collection_area_id', areaIds),
        supabase
          .from('service_rules')
          .select('collection_area_id, service_id, max_collections, extra_unit_price')
          .in('collection_area_id', areaIds),
      ])
      // Throw on fetch failure — swallowing it (`data ?? []`) would initialise
      // the editable template to all zeros, and one Save would then submit an
      // empty payload for every area in the group, deleting all its rules (and
      // cascade-deleting dependent allocation_conversion_rule swap config).
      if (allocResp.error) throw new Error(allocResp.error.message)
      if (svcResp.error) throw new Error(svcResp.error.message)
      return {
        alloc: (allocResp.data ?? []) as AllocRuleRow[],
        svc: (svcResp.data ?? []) as SvcRuleRow[],
      }
    },
  })

  // Use first area's rules as the editable "template". Diverging areas will be overwritten on save.
  const [allocValues, setAllocValues] = useState<Record<string, number>>({})
  const [svcValues, setSvcValues] = useState<Record<string, { max: number; price: number }>>({})
  const [initialised, setInitialised] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  if (rules && !initialised && firstAreaId) {
    const aMap: Record<string, number> = {}
    for (const r of rules.alloc) {
      if (r.collection_area_id === firstAreaId) aMap[r.category_id] = r.max_collections
    }
    setAllocValues(aMap)

    const sMap: Record<string, { max: number; price: number }> = {}
    for (const r of rules.svc) {
      if (r.collection_area_id === firstAreaId) sMap[r.service_id] = { max: r.max_collections, price: Number(r.extra_unit_price) }
    }
    setSvcValues(sMap)

    setInitialised(true)
  }

  const heterogeneous = rules ? detectHeterogeneity(group.areas, rules.alloc, rules.svc) : false

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSaved(false)

    const allocPayload = categories
      .filter((c) => (allocValues[c.id] ?? 0) > 0)
      .map((c) => ({ category_id: c.id, max_collections: allocValues[c.id] ?? 0 }))

    const svcPayload = services
      .filter((s) => (svcValues[s.id]?.max ?? 0) > 0 || (svcValues[s.id]?.price ?? 0) > 0)
      .map((s) => ({
        service_id: s.id,
        max_collections: svcValues[s.id]?.max ?? 0,
        extra_unit_price: svcValues[s.id]?.price ?? 0,
      }))

    for (const area of group.areas) {
      const [allocResult, svcResult] = await Promise.all([
        upsertAllocationRules(area.id, allocPayload),
        upsertServiceRules(area.id, svcPayload),
      ])
      if (!allocResult.ok) { setError(`${area.code}: ${allocResult.error}`); setSaving(false); return }
      if (!svcResult.ok) { setError(`${area.code}: ${svcResult.error}`); setSaving(false); return }
    }

    setSaving(false)
    setSaved(true)
    void queryClient.invalidateQueries({ queryKey: ['rules-group', group.key] })
    router.refresh()
    setTimeout(() => setSaved(false), 3000)
  }

  const ruleInputClass = 'w-20 rounded border border-gray-200 px-2 py-1 text-body-sm text-gray-900 outline-none focus:border-[#293F52]'
  const priceInputClass = 'w-24 rounded border border-gray-200 px-2 py-1 text-body-sm text-gray-900 outline-none focus:border-[#293F52]'

  const areaCodes = group.areas.map((a) => a.code).join(', ')

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-body font-semibold text-gray-900">{group.label}</div>
          <div className="mt-0.5 text-2xs text-gray-500">
            {group.areas.length} area{group.areas.length !== 1 ? 's' : ''}: {areaCodes}
          </div>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || isLoading || !initialised}
          className="shrink-0 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {heterogeneous && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-2xs text-amber-800">
          ⚠ Rules diverge across this group&apos;s {group.areas.length} areas. Showing the first area&apos;s values. Saving will overwrite all areas with the values below.
        </div>
      )}

      {isLoading && <div className="text-2xs text-gray-400">Loading rules…</div>}

      {initialised && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Allocation rules */}
          <div>
            <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-gray-500">
              Category max per year
            </div>
            <div className="flex flex-col gap-2">
              {categories.map((cat) => (
                <div key={cat.id} className="flex items-center gap-3">
                  <span className="w-28 text-body-sm text-gray-700">{cat.name}</span>
                  <input
                    type="number"
                    min={0}
                    value={allocValues[cat.id] ?? 0}
                    onChange={(e) => setAllocValues({ ...allocValues, [cat.id]: parseInt(e.target.value) || 0 })}
                    className={ruleInputClass}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Service rules */}
          <div>
            <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-gray-500">
              Service max + extra price
            </div>
            <div className="flex flex-col gap-2">
              {services.map((svc) => (
                <div key={svc.id} className="flex items-center gap-3">
                  <span className="w-24 text-body-sm text-gray-700">{svc.name}</span>
                  <input
                    type="number"
                    min={0}
                    value={svcValues[svc.id]?.max ?? 0}
                    onChange={(e) => setSvcValues({
                      ...svcValues,
                      [svc.id]: { max: parseInt(e.target.value) || 0, price: svcValues[svc.id]?.price ?? 0 },
                    })}
                    className={ruleInputClass}
                    aria-label={`${svc.name} max`}
                  />
                  <span className="text-2xs text-gray-400">max</span>
                  <span className="text-body-sm text-gray-400">$</span>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={svcValues[svc.id]?.price ?? 0}
                    onChange={(e) => setSvcValues({
                      ...svcValues,
                      [svc.id]: { max: svcValues[svc.id]?.max ?? 0, price: parseFloat(e.target.value) || 0 },
                    })}
                    className={priceInputClass}
                    aria-label={`${svc.name} extra price`}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-body-sm text-red-700">{error}</div>}
      {saved && <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-body-sm text-emerald-700">Saved to {group.areas.length} area{group.areas.length !== 1 ? 's' : ''}.</div>}
    </div>
  )
}
