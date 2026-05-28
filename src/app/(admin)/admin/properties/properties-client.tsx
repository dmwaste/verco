'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { invokeEfWithUserToken } from '@/lib/supabase/invoke-ef-client'
import { SkeletonRow } from '@/components/ui/skeleton'
import { AllocationFormModal } from '@/app/(admin)/admin/allocations/allocation-form-modal'
import { SetMudModal } from './set-mud-modal'

const PAGE_SIZE = 50

interface ParsedRow {
  address: string
  collection_area_code: string
  is_mud: boolean
}

interface ModalProperty {
  id: string
  address: string
  formatted_address: string | null
  collection_area_id: string
  collection_area_code: string
}

interface PropertiesClientProps {
  clientId: string
  isContractorAdmin: boolean
}

export function PropertiesClient({ clientId, isContractorAdmin }: PropertiesClientProps) {
  const supabase = createClient()
  const queryClient = useQueryClient()

  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [areaFilter, setAreaFilter] = useState('')
  const [mudFilter, setMudFilter] = useState<'all' | 'mud' | 'residential'>('all')
  const [showImport, setShowImport] = useState(false)
  const [isGeocoding, setIsGeocoding] = useState(false)
  const [geocodeResult, setGeocodeResult] = useState<string | null>(null)
  const [setMudOpen, setSetMudOpen] = useState(false)
  const [setMudProperty, setSetMudProperty] = useState<ModalProperty | null>(null)
  const [overridePropertyId, setOverridePropertyId] = useState<string | null>(null)
  const [overridePropertyAddress, setOverridePropertyAddress] = useState('')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)

  // Close menu on click outside
  const closeMenu = useCallback(() => setOpenMenuId(null), [])
  useEffect(() => {
    if (!openMenuId) return
    const handler = () => closeMenu()
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [openMenuId, closeMenu])

  // CSV import state
  const [csvRows, setCsvRows] = useState<ParsedRow[]>([])
  const [csvError, setCsvError] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // Fetch areas — tenant-scope via client_id. collection_area has a public-
  // SELECT RLS policy (USING is_active = true) for the resident booking flow,
  // which means logged-in admins see every tenant's areas without an explicit
  // filter. CLAUDE.md §21 "Public-SELECT RLS doesn't tenant-scope".
  const { data: areas } = useQuery({
    queryKey: ['collection-areas', clientId],
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

  // Fetch properties — tenant-scope via the inner-joined collection_area's
  // client_id (eligible_properties has no direct client_id column).
  const { data: propertiesData, isLoading } = useQuery({
    queryKey: ['admin-properties', debouncedSearch, areaFilter, mudFilter, page, clientId],
    queryFn: async () => {
      let query = supabase
        .from('eligible_properties')
        .select(
          'id, address, formatted_address, collection_area_id, is_mud, is_eligible, mud_code, mud_onboarding_status, unit_count, has_geocode, latitude, longitude, collection_area!inner(name, code, client_id)',
          { count: 'exact' }
        )
        .order('formatted_address', { ascending: true, nullsFirst: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (debouncedSearch) {
        query = query.or(`address.ilike.%${debouncedSearch}%,formatted_address.ilike.%${debouncedSearch}%`)
      }
      if (areaFilter) {
        query = query.eq('collection_area_id', areaFilter)
      }
      if (mudFilter === 'mud') {
        query = query.eq('is_mud', true)
      } else if (mudFilter === 'residential') {
        query = query.eq('is_mud', false)
      }
      if (clientId) {
        query = query.eq('collection_area.client_id', clientId)
      }

      const { data, count } = await query
      return { properties: data ?? [], total: count ?? 0 }
    },
  })

  // Count ungeocoded — also tenant-scoped. Needs an inner-join on
  // collection_area so the embedded filter can fire.
  const { data: ungeocodedCount } = useQuery({
    queryKey: ['ungeocoded-count', clientId],
    queryFn: async () => {
      let query = supabase
        .from('eligible_properties')
        .select('id, collection_area!inner(client_id)', { count: 'exact', head: true })
        .eq('has_geocode', false)
      if (clientId) {
        query = query.eq('collection_area.client_id', clientId)
      }
      const { count } = await query
      return count ?? 0
    },
  })

  const properties = propertiesData?.properties ?? []
  const total = propertiesData?.total ?? 0

  function handleOpenSetMudModal(p: {
    id: string
    address: string
    formatted_address: string | null
    collection_area_id: string | null
    collection_area: { code: string } | { code: string }[] | null
  }) {
    if (!p.collection_area_id) return
    const area = Array.isArray(p.collection_area) ? p.collection_area[0] : p.collection_area
    setSetMudProperty({
      id: p.id,
      address: p.address,
      formatted_address: p.formatted_address,
      collection_area_id: p.collection_area_id,
      collection_area_code: area?.code ?? '',
    })
    setSetMudOpen(true)
  }

  async function handleSetResidential(id: string) {
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
    if (error) { alert(`Failed to update: ${error.message}`); return }
    void queryClient.invalidateQueries({ queryKey: ['admin-properties'] })
  }

  async function handleToggleEligible(id: string, currentValue: boolean) {
    const { error } = await supabase
      .from('eligible_properties')
      .update({ is_eligible: !currentValue })
      .eq('id', id)
    if (error) { alert(`Failed to update: ${error.message}`); return }
    void queryClient.invalidateQueries({ queryKey: ['admin-properties'] })
  }

  async function handleGeocodeAll() {
    setIsGeocoding(true)
    setGeocodeResult(null)

    try {
      const efResult = await invokeEfWithUserToken<{ processed?: number; failed?: number }>(
        supabase,
        'geocode-properties',
        {},
        { fallbackToAnon: true }
      )

      if (!efResult.ok) {
        console.error('[geocode-properties] EF error:', efResult.error)
        setGeocodeResult(`Geocoding failed: ${efResult.error}`)
      } else {
        const result = efResult.data
        setGeocodeResult(`Geocoded ${result.processed ?? 0} properties${result.failed ? `, ${result.failed} failed` : ''}`)
        void queryClient.invalidateQueries({ queryKey: ['admin-properties'] })
        void queryClient.invalidateQueries({ queryKey: ['ungeocoded-count'] })
      }
    } catch (err) {
      console.error('[geocode-properties] unexpected error:', err)
      setGeocodeResult('Geocoding failed')
    } finally {
      setIsGeocoding(false)
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvError(null)
    setImportResult(null)

    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length < 2) {
        setCsvError('CSV must have a header row and at least one data row')
        return
      }

      const header = lines[0]!.toLowerCase().split(',').map((h) => h.trim())
      const addrIdx = header.indexOf('address')
      const areaIdx = header.indexOf('collection_area_code')
      const mudIdx = header.indexOf('is_mud')

      if (addrIdx === -1 || areaIdx === -1) {
        setCsvError('CSV must have "address" and "collection_area_code" columns')
        return
      }

      const rows: ParsedRow[] = []
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i]!.split(',').map((c) => c.trim())
        const address = cols[addrIdx] ?? ''
        const code = cols[areaIdx] ?? ''
        const mud = mudIdx >= 0 ? (cols[mudIdx] ?? '').toLowerCase() === 'true' : false

        if (address && code) {
          rows.push({ address, collection_area_code: code, is_mud: mud })
        }
      }

      if (rows.length === 0) {
        setCsvError('No valid rows found in CSV')
        return
      }

      setCsvRows(rows)
    }
    reader.readAsText(file)
  }

  async function handleImportConfirm() {
    if (csvRows.length === 0 || !areas) return
    setIsImporting(true)
    setImportResult(null)

    const areaMap = new Map(areas.map((a) => [a.code, a.id]))
    let inserted = 0
    let failed = 0

    // Batch insert in chunks of 100
    for (let i = 0; i < csvRows.length; i += 100) {
      const chunk = csvRows.slice(i, i + 100)
      const rows = chunk
        .map((r) => {
          const areaId = areaMap.get(r.collection_area_code)
          if (!areaId) {
            failed++
            return null
          }
          return {
            address: r.address,
            collection_area_id: areaId,
            is_mud: r.is_mud,
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

      if (rows.length > 0) {
        const { error } = await supabase.from('eligible_properties').insert(rows)
        if (error) {
          failed += rows.length
        } else {
          inserted += rows.length
        }
      }
    }

    setIsImporting(false)
    setImportResult(`Imported ${inserted} properties${failed > 0 ? `, ${failed} failed` : ''}`)
    setCsvRows([])
    if (fileInputRef.current) fileInputRef.current.value = ''
    void queryClient.invalidateQueries({ queryKey: ['admin-properties'] })
    void queryClient.invalidateQueries({ queryKey: ['ungeocoded-count'] })

    // Auto-trigger geocoding for new properties
    if (inserted > 0) {
      void handleGeocodeAll()
    }
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Eligible Properties
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            {total} propert{total !== 1 ? 'ies' : 'y'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isContractorAdmin && (
            <button
              type="button"
              onClick={handleGeocodeAll}
              disabled={isGeocoding || (ungeocodedCount ?? 0) === 0}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-body-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {isGeocoding ? 'Geocoding...' : `Geocode All (${ungeocodedCount ?? 0} pending)`}
            </button>
          )}
          {isContractorAdmin && (
            <button
              type="button"
              onClick={() => setShowImport((p) => !p)}
              className="rounded-lg bg-[#00E47C] px-4 py-2 text-body-sm font-semibold text-[#293F52]"
            >
              Import Properties
            </button>
          )}
        </div>
      </div>

      {geocodeResult && (
        <div className="mx-7 mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">
          {geocodeResult}
        </div>
      )}

      {/* CSV Import */}
      {showImport && (
        <div className="mx-7 mt-4 rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-semibold text-[#293F52]">Import Properties from CSV</h3>
          <p className="mb-3 text-xs text-gray-500">
            CSV must have columns: <code className="rounded bg-gray-100 px-1">address</code>, <code className="rounded bg-gray-100 px-1">collection_area_code</code>, <code className="rounded bg-gray-100 px-1">is_mud</code> (optional, true/false)
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileSelect}
            className="block w-full text-sm text-gray-500 file:mr-4 file:rounded-lg file:border-0 file:bg-gray-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-gray-700"
          />
          {csvError && <p className="mt-2 text-sm text-red-600">{csvError}</p>}
          {importResult && <p className="mt-2 text-sm text-emerald-600">{importResult}</p>}

          {csvRows.length > 0 && (
            <div className="mt-3">
              <div className="mb-2 text-xs font-semibold text-gray-500">
                Preview ({csvRows.length} rows total — showing first 5):
              </div>
              <div className="overflow-x-auto rounded-lg border border-gray-100">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500">
                      <th className="px-3 py-1.5 text-left">Address</th>
                      <th className="px-3 py-1.5 text-left">Area Code</th>
                      <th className="px-3 py-1.5 text-center">MUD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvRows.slice(0, 5).map((r, i) => (
                      <tr key={i} className="border-t border-gray-50">
                        <td className="px-3 py-1.5">{r.address}</td>
                        <td className="px-3 py-1.5">{r.collection_area_code}</td>
                        <td className="px-3 py-1.5 text-center">{r.is_mud ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={handleImportConfirm}
                  disabled={isImporting}
                  className="rounded-lg bg-[#293F52] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {isImporting ? 'Importing...' : `Import ${csvRows.length} Properties`}
                </button>
                <button
                  type="button"
                  onClick={() => { setCsvRows([]); if (fileInputRef.current) fileInputRef.current.value = '' }}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3 px-7 pt-6">
        <div className="flex-1">
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search by address..."
            aria-label="Search properties"
            className="w-full max-w-sm rounded-lg border border-gray-200 px-3.5 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-[#293F52]"
          />
        </div>
        <select
          value={areaFilter}
          onChange={(e) => { setAreaFilter(e.target.value); setPage(0) }}
          aria-label="Filter by area"
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
        >
          <option value="">All areas</option>
          {(areas ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
          ))}
        </select>
        <select
          value={mudFilter}
          onChange={(e) => { setMudFilter(e.target.value as typeof mudFilter); setPage(0) }}
          aria-label="Filter by type"
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
        >
          <option value="all">All types</option>
          <option value="mud">MUD only</option>
          <option value="residential">Residential only</option>
        </select>
      </div>

      {/* Table */}
      <div className="mx-7 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-500">
              <th className="px-4 py-3">Address</th>
              <th className="px-4 py-3">Area</th>
              <th className="px-4 py-3 text-center">Type</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <>{Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={4} />
              ))}</>
            ) : properties.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No properties found</td></tr>
            ) : (
              properties.map((p, rowIndex) => {
                const area = p.collection_area as { name: string; code: string }
                const menuAbove = rowIndex >= 3
                return (
                  <tr key={p.id} className={`border-b border-gray-50 ${!p.is_eligible ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Link href={`/admin/properties/${p.id}`} className="font-medium text-[#293F52] hover:underline">{p.formatted_address ?? p.address}</Link>
                        {!p.is_eligible && (
                          <span className="rounded-full bg-[#FFF0F0] px-2 py-0.5 text-2xs font-semibold text-[#E53E3E]">Ineligible</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{area.code}</td>
                    <td className="px-4 py-2.5 text-center">
                      {p.is_mud ? (
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="rounded-full bg-[#F3EEFF] px-2 py-0.5 text-2xs font-semibold text-[#805AD5]">
                            {p.mud_code ?? 'MUD'}
                          </span>
                          {p.mud_onboarding_status && (
                            <span className={`text-2xs font-medium ${
                              p.mud_onboarding_status === 'Registered'
                                ? 'text-emerald-600'
                                : p.mud_onboarding_status === 'Inactive'
                                ? 'text-red-500'
                                : 'text-gray-500'
                            }`}>
                              {p.mud_onboarding_status} · {p.unit_count}u
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[11px] text-gray-400">Residential</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="relative inline-block">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === p.id ? null : p.id) }}
                          className="inline-flex items-center justify-center rounded-md border-[1.5px] border-gray-100 bg-white px-2 py-1 text-gray-500 hover:bg-gray-50"
                          aria-label="Property actions"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                        </button>
                        {openMenuId === p.id && (
                          <div className={`absolute right-0 z-10 w-44 rounded-lg border border-gray-100 bg-white py-1 shadow-lg ${menuAbove ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
                            <button
                              type="button"
                              onClick={() => {
                                setOverridePropertyId(p.id)
                                setOverridePropertyAddress(p.formatted_address ?? p.address)
                                setOpenMenuId(null)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm text-gray-700 hover:bg-gray-50"
                            >
                              Add Allocations
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (p.is_mud) {
                                  void handleSetResidential(p.id)
                                } else {
                                  handleOpenSetMudModal(p)
                                }
                                setOpenMenuId(null)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm text-gray-700 hover:bg-gray-50"
                            >
                              {p.is_mud ? 'Set Residential' : 'Set MUD'}
                            </button>
                            <button
                              type="button"
                              onClick={() => { void handleToggleEligible(p.id, p.is_eligible); setOpenMenuId(null) }}
                              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm hover:bg-gray-50 ${p.is_eligible ? 'text-[#E53E3E]' : 'text-emerald-600'}`}
                            >
                              {p.is_eligible ? 'Mark Ineligible' : 'Mark Eligible'}
                            </button>
                          </div>
                        )}
                      </div>
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
            <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium disabled:opacity-30">
              Previous
            </button>
            <button type="button" onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * PAGE_SIZE >= total} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium disabled:opacity-30">
              Next
            </button>
          </div>
        </div>
      )}

      <SetMudModal
        open={setMudOpen}
        onOpenChange={setSetMudOpen}
        property={setMudProperty}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: ['admin-properties'] })
        }}
      />

      {overridePropertyId && (
        <AllocationFormModal
          open={!!overridePropertyId}
          onOpenChange={(open) => { if (!open) setOverridePropertyId(null) }}
          onSave={() => {
            void queryClient.invalidateQueries({ queryKey: ['allocation_overrides'] })
            setOverridePropertyId(null)
          }}
          propertyId={overridePropertyId}
          propertyAddress={overridePropertyAddress}
        />
      )}
    </>
  )
}
