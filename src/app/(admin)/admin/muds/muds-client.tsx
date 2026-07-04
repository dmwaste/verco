'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'
import { SkeletonRow } from '@/components/ui/skeleton'
import { RowActionMenu } from '@/components/admin/row-action-menu'
import { Th } from '@/components/admin/th'
import { Pagination } from '@/components/admin/pagination'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'
import { StatusBadge, Pill } from '@/components/status-badge'

const PAGE_SIZE = 50

// mud_onboarding_status enum — see 20260408100000_mud_create_enums.sql.
// Nullable for is_mud=true rows that pre-date the column.
type OnboardingStatus = 'Contact Made' | 'Registered' | 'Inactive'
const ONBOARDING_STATUSES: OnboardingStatus[] = ['Contact Made', 'Registered', 'Inactive']

interface MudsClientProps {
  clientId: string
  isContractorAdmin: boolean
}

export function MudsClient({ clientId, isContractorAdmin }: MudsClientProps) {
  const supabase = createClient()
  const queryClient = useQueryClient()

  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [areaFilter, setAreaFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | OnboardingStatus | 'unset'>('')
  // Debounce search
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function handleSearchChange(value: string) {
    setSearch(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(value)
      setPage(0)
    }, 300)
  }

  // Fetch tenant areas — collection_area has public-SELECT RLS so we MUST
  // tenant-scope explicitly via client_id (CLAUDE.md §21).
  const { data: areas } = useQuery({
    queryKey: ['muds-areas', clientId],
    queryFn: async () => {
      let query = supabase
        .from('collection_area')
        .select('id, code, name')
        .eq('is_active', true)
        .order('code')
      if (clientId) {
        query = query.eq('client_id', clientId)
      }
      const { data } = await query
      return data ?? []
    },
  })

  // Status-counts strip — single query, count per onboarding status.
  // Includes a "Not set" bucket for is_mud=true rows with NULL status.
  const { data: statusCounts } = useQuery({
    queryKey: ['muds-status-counts', clientId],
    queryFn: async () => {
      let query = supabase
        .from('eligible_properties')
        .select('mud_onboarding_status, collection_area!inner(client_id)')
        .eq('is_mud', true)
      if (clientId) {
        query = query.eq('collection_area.client_id', clientId)
      }
      const { data } = await query
      const counts: Record<string, number> = {
        'Contact Made': 0,
        Registered: 0,
        Inactive: 0,
        unset: 0,
      }
      for (const row of data ?? []) {
        const key = row.mud_onboarding_status ?? 'unset'
        counts[key] = (counts[key] ?? 0) + 1
      }
      return counts
    },
  })

  // Fetch MUDs — is_mud=true, tenant-scoped via embedded collection_area
  // inner join (eligible_properties has no direct client_id).
  // Embeds strata contact for the Contact column (PII gated to admin/staff
  // roles only — admin layout guards this; field/ranger never hit this page).
  const { data: mudsData, isLoading } = useQuery({
    queryKey: ['admin-muds', debouncedSearch, areaFilter, statusFilter, page, clientId],
    queryFn: async () => {
      let query = supabase
        .from('eligible_properties')
        .select(
          `id, address, formatted_address, collection_area_id, is_eligible,
           mud_code, mud_onboarding_status, unit_count, collection_cadence,
           strata_contact_id, auth_form_url,
           collection_area!inner(name, code, client_id),
           strata_contact:contacts!eligible_properties_strata_contact_id_fkey(first_name, last_name, full_name)`,
          { count: 'exact' }
        )
        .eq('is_mud', true)
        .order('formatted_address', { ascending: true, nullsFirst: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (debouncedSearch) {
        query = query.or(
          buildSearchOrFilter(
            ['address', 'formatted_address', 'mud_code'],
            debouncedSearch
          )
        )
      }
      if (areaFilter) {
        query = query.eq('collection_area_id', areaFilter)
      }
      if (statusFilter === 'unset') {
        query = query.is('mud_onboarding_status', null)
      } else if (statusFilter) {
        query = query.eq('mud_onboarding_status', statusFilter)
      }
      if (clientId) {
        query = query.eq('collection_area.client_id', clientId)
      }

      const { data, count } = await query
      return { muds: data ?? [], total: count ?? 0 }
    },
  })

  const muds = mudsData?.muds ?? []
  const total = mudsData?.total ?? 0

  async function handleSetResidential(id: string) {
    if (!confirm('Convert this MUD back to a residential property? This will clear MUD-specific fields.')) return
    const { error } = await supabase
      .from('eligible_properties')
      .update({
        is_mud: false,
        mud_onboarding_status: null,
        collection_cadence: null,
        unit_count: 1,
        mud_code: null,
        strata_contact_id: null,
        auth_form_url: null,
        waste_location_notes: null,
      })
      .eq('id', id)
    if (error) {
      alert(`Failed to update: ${error.message}`)
      return
    }
    void queryClient.invalidateQueries({ queryKey: ['admin-muds'] })
    void queryClient.invalidateQueries({ queryKey: ['muds-status-counts'] })
  }

  const statusPills: Array<{ key: 'Contact Made' | 'Registered' | 'Inactive' | 'unset'; label: string; color: string }> = [
    { key: 'Contact Made', label: 'Contact Made', color: 'text-amber-600 border-amber-200 bg-amber-50' },
    { key: 'Registered', label: 'Registered', color: 'text-emerald-600 border-emerald-200 bg-emerald-50' },
    { key: 'Inactive', label: 'Inactive', color: 'text-red-500 border-red-200 bg-red-50' },
    { key: 'unset', label: 'Not Set', color: 'text-gray-500 border-gray-200 bg-gray-50' },
  ]

  return (
    <>
      {/* Header */}
      <PageHeader
        title="Multi-Unit Dwellings"
        subtitle={`${total} MUD${total !== 1 ? 's' : ''}${isContractorAdmin ? ' — manage from the Properties page to convert a residential property into a MUD.' : ''}`}
      >
        <Link
          href="/admin/properties?mud=true"
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-body-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          All Properties &rarr;
        </Link>
      </PageHeader>

      {/* Status counts strip */}
      <div className="mx-7 mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {statusPills.map((pill) => (
          <button
            key={pill.key}
            type="button"
            onClick={() => { setStatusFilter(statusFilter === pill.key ? '' : pill.key); setPage(0) }}
            className={`rounded-xl border px-4 py-3 text-left transition-colors ${pill.color} ${statusFilter === pill.key ? 'ring-2 ring-[#293F52]' : ''}`}
          >
            <div className="text-caption font-semibold uppercase tracking-wide">{pill.label}</div>
            <div className="mt-1 text-xl font-bold">{statusCounts?.[pill.key] ?? 0}</div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <FilterBar>
        <SearchInput
          value={search}
          onChange={handleSearchChange}
          placeholder="Search by address or MUD code..."
          ariaLabel="Search MUDs"
        />
        <FilterSelect
          value={areaFilter}
          onChange={(e) => { setAreaFilter(e.target.value); setPage(0) }}
          aria-label="Filter by area"
        >
          <option value="">All areas</option>
          {(areas ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
          ))}
        </FilterSelect>
        <FilterSelect
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setPage(0) }}
          aria-label="Filter by onboarding status"
        >
          <option value="">All statuses</option>
          {ONBOARDING_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
          <option value="unset">Not Set</option>
        </FilterSelect>
      </FilterBar>

      {/* Table */}
      <div className="mx-7 overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-left text-sm tabular-nums">
          <thead>
            <tr>
              <Th>Address</Th>
              <Th>Area</Th>
              <Th>MUD Code</Th>
              <Th className="text-right">Units</Th>
              <Th>Status</Th>
              <Th>Strata Contact</Th>
              <Th>Cadence</Th>
              <Th>Auth form</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <>{Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={9} />
              ))}</>
            ) : muds.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">No MUDs found</td></tr>
            ) : (
              muds.map((m) => {
                const area = m.collection_area as { name: string; code: string }
                const contact = m.strata_contact as { full_name: string | null } | null
                return (
                  <tr key={m.id} className={`border-b border-gray-50 ${!m.is_eligible ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/admin/properties/${m.id}`}
                          className="font-medium text-[#293F52] hover:underline"
                        >
                          {m.formatted_address ?? m.address}
                        </Link>
                        {!m.is_eligible && (
                          <span className="rounded-full bg-[#FFF0F0] px-2 py-0.5 text-2xs font-semibold text-[#E53E3E]">Ineligible</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{area.code}</td>
                    <td className="px-4 py-2.5">
                      <span className="rounded-full bg-[#F3EEFF] px-2 py-0.5 text-2xs font-semibold text-[#805AD5]">
                        {m.mud_code ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-700">{m.unit_count ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      {m.mud_onboarding_status ? (
                        <StatusBadge entity="mudOnboarding" status={m.mud_onboarding_status} />
                      ) : (
                        <span className="text-xs text-gray-400">Not set</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">
                      {contact?.full_name ?? <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{m.collection_cadence ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-2.5">
                      {m.auth_form_url ? (
                        <Pill tone="success">✓ PDF</Pill>
                      ) : (
                        <span className="text-2xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <RowActionMenu
                        ariaLabel="MUD actions"
                        actions={[
                          { label: 'Edit MUD details', href: `/admin/properties/${m.id}` },
                          { label: 'Set Residential', onSelect: () => { void handleSetResidential(m.id) }, tone: 'danger' },
                        ]}
                      />
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <Pagination className="mx-7" page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
    </>
  )
}
