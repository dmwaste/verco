'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient as createBrowserClient } from '@/lib/supabase/client'
import type { Database } from '@/lib/supabase/types'
import { RulesGroupRow, type RulesGroup } from './rules-group-row'

type Client = Database['public']['Tables']['client']['Row']

interface Category { id: string; name: string; code: string }
interface Service { id: string; name: string; category_id: string }

interface RulesTabProps {
  client: Client
  categories: Category[]
  services: Service[]
}

/**
 * Rules tab — groups rules editing by sub-client when present, otherwise
 * one group per direct collection_area. Each group writes its rules to all
 * its areas on save, so per-sub-client edits don't clobber unrelated LGAs.
 *
 * Heterogeneity: if a group has multiple areas with diverging rules, the
 * row surfaces a warning before save.
 */
export function RulesTab({ client, categories, services }: RulesTabProps) {
  const supabase = createBrowserClient()

  // Fetch sub-clients and their areas separately, then stitch together in the
  // groups memo below. The earlier embedded `collection_area(...)` syntax
  // returned empty arrays for authenticated admins once collection_area gained
  // additional FKs (capacity_pool_id added 2026-05-13). Separate query is
  // robust against PostgREST's embedded-resolution edge cases.
  const { data: subClients } = useQuery({
    queryKey: ['admin-rules-sub-clients', client.id],
    queryFn: async () => {
      const [scResp, caResp] = await Promise.all([
        supabase
          .from('sub_client')
          .select('id, name, code')
          .eq('client_id', client.id)
          .order('code'),
        supabase
          .from('collection_area')
          .select('id, code, sub_client_id, is_active')
          .eq('client_id', client.id)
          .eq('is_active', true)
          .not('sub_client_id', 'is', null),
      ])

      const areasBySc = new Map<string, Array<{ id: string; code: string; is_active: boolean | null }>>()
      for (const a of caResp.data ?? []) {
        if (!a.sub_client_id) continue
        const bucket = areasBySc.get(a.sub_client_id) ?? []
        bucket.push({ id: a.id, code: a.code, is_active: a.is_active })
        areasBySc.set(a.sub_client_id, bucket)
      }

      return (scResp.data ?? []).map((sc) => ({
        ...sc,
        collection_area: areasBySc.get(sc.id) ?? [],
      }))
    },
  })

  // Pull "orphan" areas (no sub_client_id) — Kwinana lives here.
  const { data: orphanAreas } = useQuery({
    queryKey: ['admin-rules-orphan-areas', client.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('collection_area')
        .select('id, code, is_active')
        .eq('client_id', client.id)
        .is('sub_client_id', null)
        .eq('is_active', true)
        .order('code')
      return data ?? []
    },
  })

  const groups: RulesGroup[] = useMemo(() => {
    const out: RulesGroup[] = []

    for (const sc of subClients ?? []) {
      const activeAreas = (sc.collection_area ?? []).filter((a) => a.is_active).map((a) => ({ id: a.id, code: a.code }))
      if (activeAreas.length === 0) continue
      out.push({
        key: `sc-${sc.id}`,
        label: sc.name,
        kind: 'sub-client',
        areas: activeAreas,
      })
    }

    if ((orphanAreas ?? []).length > 0) {
      for (const a of orphanAreas ?? []) {
        out.push({
          key: `area-${a.id}`,
          label: a.code,
          kind: 'area',
          areas: [{ id: a.id, code: a.code }],
        })
      }
    }

    return out
  }, [subClients, orphanAreas])

  return (
    <div className="max-w-2xl">
      <div className="mb-4 text-2xs text-gray-400">
        Rules apply per sub-client when sub-clients are configured; otherwise per area. Each row&apos;s Save writes only to its own areas.
      </div>

      {groups.length === 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-body-sm text-amber-800">
          No collection areas configured. Add sub-clients and/or areas first.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <RulesGroupRow
            key={group.key}
            group={group}
            categories={categories}
            services={services}
          />
        ))}
      </div>
    </div>
  )
}
