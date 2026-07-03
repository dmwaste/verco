'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { SkeletonRow } from '@/components/ui/skeleton'
import { AllocationFormModal } from './allocation-form-modal'
import { Th } from '@/components/admin/th'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'

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
  /** contractor-admin / client-admin only — gates the edit (pencil) action.
   *  RLS still enforces writes; this only hides the UI for read-only roles. */
  canManage: boolean
}

export function AllocationsList({ clientId, canManage }: AllocationsListProps) {
  const supabase = createClient()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [filterFyId, setFilterFyId] = useState<string>('')
  const [editRow, setEditRow] = useState<AllocationOverrideRow | null>(null)

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
      <PageHeader title="Allocation Overrides" subtitle={`${total} override${total !== 1 ? 's' : ''}`} />

      {/* Filters */}
      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search address, service, reason..."
          ariaLabel="Search allocation overrides"
        />

        <FilterSelect
          value={filterFyId}
          onChange={(e) => setFilterFyId(e.target.value)}
          aria-label="Filter by financial year"
        >
          <option value="">All Financial Years</option>
          {financialYears?.map((fy) => (
            <option key={fy.id} value={fy.id}>{fy.label}</option>
          ))}
        </FilterSelect>

        <div className="flex-1" />
        <span className="text-xs text-gray-500">
          {total} result{total !== 1 ? 's' : ''}
        </span>
      </FilterBar>

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th>Property</Th>
                <Th>Service</Th>
                <Th>FY</Th>
                <Th className="text-right">Extra</Th>
                <Th>Reason</Th>
                <Th>Created By</Th>
                <Th>Date</Th>
                {canManage && (
                  <Th className="text-right">Actions</Th>
                )}
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={canManage ? 8 : 7} />
              ))}
              {!isLoading && total === 0 && (
                <tr><td colSpan={canManage ? 8 : 7} className="px-4 py-8 text-center text-sm text-gray-400">No allocation overrides found</td></tr>
              )}
              {filtered?.map((override) => (
                <tr key={override.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                  <td className="max-w-[200px] truncate px-4 py-3 text-body-sm font-medium text-gray-900">
                    {override.eligible_properties.formatted_address || override.eligible_properties.address}
                  </td>
                  <td className="px-4 py-3 text-body-sm text-gray-700">
                    {override.service?.name}
                    <span className="ml-1 text-caption text-gray-400">({override.service?.category?.name})</span>
                  </td>
                  <td className="px-4 py-3 text-body-sm text-gray-700">
                    {override.financial_year?.label}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={`inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-caption font-semibold ${override.extra_allocations < 0 ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-[#293F52]'}`}>
                      {override.extra_allocations > 0 ? '+' : ''}{override.extra_allocations}
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
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setEditRow(override)}
                        aria-label="Adjust allocation"
                        title="Adjust allocation"
                        className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-[var(--brand)]"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editRow && (
        <AllocationFormModal
          open={!!editRow}
          onOpenChange={(open) => { if (!open) setEditRow(null) }}
          onSave={() => {
            void queryClient.invalidateQueries({ queryKey: ['allocation_overrides'] })
            setEditRow(null)
          }}
          propertyId={editRow.property_id}
          propertyAddress={editRow.eligible_properties.formatted_address || editRow.eligible_properties.address}
          editOverride={{
            id: editRow.id,
            service_id: editRow.service_id,
            fy_id: editRow.fy_id,
            fy_label: editRow.financial_year?.label,
            extra_allocations: editRow.extra_allocations,
            reason: editRow.reason,
          }}
        />
      )}
    </>
  )
}
