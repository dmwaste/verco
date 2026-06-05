'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { SkeletonRow } from '@/components/ui/skeleton'

interface AllocationOverrideRow {
  id: string
  property_id: string
  service_id: string
  fy_id: string
  extra_allocations: number
  reason: string
  created_by: string
  created_at: string
  updated_at: string
  eligible_properties: {
    address: string
    formatted_address: string | null
    collection_area_id: string
  }
  service: {
    name: string
    category: {
      name: string
    }
  }
  financial_year: {
    label: string
  }
  profiles: {
    email: string
  }
}

interface AllocationsListProps {
  /** Selected tenant from the admin switcher. allocation_override has no
   *  client_id column, so we scope through property → collection_area → client. */
  clientId: string
}

export function AllocationsList({ clientId }: AllocationsListProps) {
  const supabase = createClient()
  const [search, setSearch] = useState('')
  const [filterFyId, setFilterFyId] = useState<string>('')

  const { data: overrides, isLoading } = useQuery({
    queryKey: ['allocation_overrides', clientId, filterFyId],
    queryFn: async () => {
      let query = supabase
        .from('allocation_override')
        .select(
          `*,
          eligible_properties!inner(address, formatted_address, collection_area_id, collection_area:collection_area_id!inner(client_id)),
          service!inner(name, category!inner(name)),
          financial_year(label),
          profiles:created_by(email)`
        )

      // Scope to the selected tenant via the property's collection area
      // (allocation_override itself carries no client_id).
      if (clientId) {
        query = query.eq('eligible_properties.collection_area.client_id', clientId)
      }

      if (filterFyId) {
        query = query.eq('fy_id', filterFyId)
      }

      const { data, error } = await query.order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as unknown as AllocationOverrideRow[]
    },
  })

  const { data: financialYears } = useQuery({
    queryKey: ['financial_years'],
    queryFn: async () => {
      const { data } = await supabase
        .from('financial_year')
        .select('id, label')
        .order('label', { ascending: false })
      return data ?? []
    },
  })

  const filtered = overrides?.filter((o) => {
    if (!search) return true
    const s = search.toLowerCase()
    const address = (o.eligible_properties.formatted_address || o.eligible_properties.address).toLowerCase()
    return address.includes(s) || o.service?.name.toLowerCase().includes(s) || o.reason.toLowerCase().includes(s)
  })

  const total = filtered?.length ?? 0

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Allocation Overrides
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            {total} override{total !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2.5 px-7 py-4">
        <div className="flex w-60 items-center gap-2 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search address, service, reason..."
            aria-label="Search allocation overrides"
            className="w-full border-none bg-transparent text-body-sm text-gray-900 outline-none placeholder:text-gray-300"
          />
        </div>

        <select
          value={filterFyId}
          onChange={(e) => setFilterFyId(e.target.value)}
          aria-label="Filter by financial year"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All Financial Years</option>
          {financialYears?.map((fy) => (
            <option key={fy.id} value={fy.id}>{fy.label}</option>
          ))}
        </select>

        <div className="flex-1" />
        <span className="text-xs text-gray-500">
          {total} result{total !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Property</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Service</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">FY</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">Extra</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Reason</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Created By</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Date</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={7} />
              ))}
              {!isLoading && total === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">No allocation overrides found</td></tr>
              )}
              {filtered?.map((override) => (
                <tr key={override.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                  <td className="max-w-[200px] truncate px-4 py-3 text-body-sm font-medium text-gray-900">
                    {override.eligible_properties.formatted_address || override.eligible_properties.address}
                  </td>
                  <td className="px-4 py-3 text-body-sm text-gray-700">
                    {override.service?.name}
                    <span className="ml-1 text-[11px] text-gray-400">({override.service?.category?.name})</span>
                  </td>
                  <td className="px-4 py-3 text-body-sm text-gray-700">
                    {override.financial_year?.label}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="inline-flex items-center justify-center rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-semibold text-[#293F52]">
                      +{override.extra_allocations}
                    </span>
                  </td>
                  <td className="max-w-[180px] truncate px-4 py-3 text-body-sm text-gray-700">
                    {override.reason}
                  </td>
                  <td className="px-4 py-3 text-body-sm text-gray-500">
                    {override.profiles?.email}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {new Date(override.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
