'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'
import { SkeletonRow } from '@/components/ui/skeleton'
import { RowActionMenu } from '@/components/admin/row-action-menu'

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
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Multi-Unit Dwellings
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            {total} MUD{total !== 1 ? 's' : ''}
            {isContractorAdmin ? ' — manage from the Properties page to convert a residential property into a MUD.' : ''}
          </p>
        </div>
        <Link
          href="/admin/properties?mud=true"
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-body-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          All Properties &rarr;
        </Link>
      </div>

      {/* Status counts strip */}
      <div className="mx-7 mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {statusPills.map((pill) => (
          <button
            key={pill.key}
            type="button"
            onClick={() => { setStatusFilter(statusFilter === pill.key ? '' : pill.key); setPage(0) }}
            className={`rounded-xl border px-4 py-3 text-left transition-colors ${pill.color} ${statusFilter === pill.key ? 'ring-2 ring-[#293F52]' : ''}`}
          >
            <div className="text-2xs font-semibold uppercase tracking-wide">{pill.label}</div>
            <div className="mt-1 text-xl font-bold">{statusCounts?.[pill.key] ?? 0}</div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2.5 px-7 py-4">
        <div className="flex w-60 items-center gap-2 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search by address or MUD code..."
            aria-label="Search MUDs"
            className="w-full border-none bg-transparent text-body-sm text-gray-900 outline-none placeholder:text-gray-300"
          />
        </div>
        <select
          value={areaFilter}
          onChange={(e) => { setAreaFilter(e.target.value); setPage(0) }}
          aria-label="Filter by area"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All areas</option>
          {(areas ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setPage(0) }}
          aria-label="Filter by onboarding status"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All statuses</option>
          {ONBOARDING_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
          <option value="unset">Not Set</option>
        </select>
      </div>

      {/* Table */}
      <div className="mx-7 overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <th className="px-4 py-3">Address</th>
              <th className="px-4 py-3">Area</th>
              <th className="px-4 py-3">MUD Code</th>
              <th className="px-4 py-3 text-right">Units</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Strata Contact</th>
              <th className="px-4 py-3">Cadence</th>
              <th className="px-4 py-3">Auth form</th>
              <th className="px-4 py-3 text-right">Actions</th>
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
                        <span className={`text-xs font-medium ${
                          m.mud_onboarding_status === 'Registered' ? 'text-emerald-600' :
                          m.mud_onboarding_status === 'Inactive' ? 'text-red-500' :
                          'text-amber-600'
                        }`}>
                          {m.mud_onboarding_status}
                        </span>
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
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-2xs font-semibold text-emerald-700">✓ PDF</span>
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
      {total > 0 && (
        <div className="mx-7 mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>
            Showing {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium disabled:opacity-30"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={(page + 1) * PAGE_SIZE >= total}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  )
}
