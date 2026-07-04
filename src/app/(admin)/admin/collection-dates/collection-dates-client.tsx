'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format, addWeeks, addMonths } from 'date-fns'
import { Dialog } from '@base-ui/react/dialog'
import { createClient } from '@/lib/supabase/client'
import { SkeletonRow } from '@/components/ui/skeleton'
import type { ResolvedAuditEntry } from '@/lib/audit/resolve'
import { AuditTimeline } from '@/components/audit-timeline'
import { fetchCollectionDateAudit } from './actions'
import { effectiveCapacity, indexPoolDates } from '@/lib/capacity/effective-capacity'
import {
  CLOSURE_REASON,
  closureReason,
  closureStatus,
} from '@/lib/collection-dates/closure-status'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { Pagination } from '@/components/admin/pagination'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'
import { PageHeader } from '@/components/admin/page-header'
import { Th } from '@/components/admin/th'

const PAGE_SIZE = 50

function capacityColor(booked: number, limit: number): string {
  if (limit === 0) return 'bg-gray-200'
  const pct = (booked / limit) * 100
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 60) return 'bg-amber-400'
  return 'bg-emerald-500'
}

function capacityBgColor(booked: number, limit: number): string {
  if (limit === 0) return 'bg-gray-100'
  const pct = (booked / limit) * 100
  if (pct >= 90) return 'bg-red-100'
  if (pct >= 60) return 'bg-amber-100'
  return 'bg-emerald-100'
}

type Frequency = 'weekly' | 'fortnightly' | 'monthly'

interface CollectionDatesClientProps {
  clientId: string
  clientSlug: string
  isContractorAdmin: boolean
}

export function CollectionDatesClient({ clientId, clientSlug, isContractorAdmin }: CollectionDatesClientProps) {
  const supabase = createClient()
  const queryClient = useQueryClient()

  // Verge Valet doesn't use the Ancillary capacity bucket — hide every ANC
  // header/cell/input for that tenant. Kwinana (and any other tenant) keeps it.
  // The 'bulk' enum/columns are unaffected; this is display-only.
  const showAnc = clientSlug !== 'vergevalet'

  const [page, setPage] = useState(0)
  const [showPast, setShowPast] = useState(false)
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')
  const [filterAreaId, setFilterAreaId] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showBulkCreate, setShowBulkCreate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [auditDialogId, setAuditDialogId] = useState<string | null>(null)
  const [auditEntries, setAuditEntries] = useState<ResolvedAuditEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(false)

  // Create form state
  const [createAreaId, setCreateAreaId] = useState('')
  const [createDate, setCreateDate] = useState('')
  const [createForMud, setCreateForMud] = useState(false)
  const [createBulkLimit, setCreateBulkLimit] = useState(60)
  const [createAncLimit, setCreateAncLimit] = useState(60)
  const [createIdLimit, setCreateIdLimit] = useState(10)
  const [createIsOpen, setCreateIsOpen] = useState(true)
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  // Bulk create state
  const [bulkAreaId, setBulkAreaId] = useState('')
  const [bulkStartDate, setBulkStartDate] = useState('')
  const [bulkCount, setBulkCount] = useState(4)
  const [bulkFrequency, setBulkFrequency] = useState<Frequency>('weekly')
  const [bulkBulkLimit, setBulkBulkLimit] = useState(60)
  const [bulkAncLimit, setBulkAncLimit] = useState(60)
  const [bulkIdLimit, setBulkIdLimit] = useState(10)
  const [showBulkPreview, setShowBulkPreview] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [isBulkCreating, setIsBulkCreating] = useState(false)

  // Edit state
  const [editBulkLimit, setEditBulkLimit] = useState(60)
  const [editAncLimit, setEditAncLimit] = useState(60)
  const [editIdLimit, setEditIdLimit] = useState(10)
  const [editIsOpen, setEditIsOpen] = useState(true)
  const [editForMud, setEditForMud] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  // Fetch areas — must filter by clientId because collection_area has a
  // public-SELECT RLS policy (`USING (is_active = true)`) for the resident
  // booking flow, which doesn't tenant-scope (CLAUDE.md §21). Without the
  // explicit filter a client-admin sees every tenant's areas.
  const { data: areas } = useQuery({
    queryKey: ['collection-areas', clientId],
    queryFn: async () => {
      let query = supabase
        .from('collection_area')
        .select('id, code, name, capacity_pool_id, capacity_pool:capacity_pool_id(code, name)')
        .eq('is_active', true)
        .order('code')
      if (clientId) {
        query = query.eq('client_id', clientId)
      }
      const { data } = await query
      return data ?? []
    },
  })

  const areaPoolById = new Map(
    (areas ?? []).map((a) => {
      const pool = Array.isArray(a.capacity_pool) ? a.capacity_pool[0] : a.capacity_pool
      return [a.id, { poolId: a.capacity_pool_id ?? null, poolCode: pool?.code ?? null }]
    }),
  )

  // Fetch collection dates — same tenant-scoping rule. The embedded
  // collection_area is `!inner` so we can filter on its client_id.
  // AWST clock, not the viewer's browser — "past" must agree with the T-3
  // hard-close cron (VER-259). `today` is part of the queryKey so a tab left
  // open across AWST midnight doesn't keep serving the stale row set.
  const today = awstDateFromUtc(new Date())
  const { data: datesData, isLoading } = useQuery({
    queryKey: ['admin-collection-dates', showPast, page, clientId, today, filterFrom, filterTo, filterAreaId],
    queryFn: async () => {
      let query = supabase
        .from('collection_date')
        .select(
          'id, date, is_open, locked_closed, for_mud, bulk_capacity_limit, bulk_units_booked, bulk_is_closed, anc_capacity_limit, anc_units_booked, anc_is_closed, id_capacity_limit, id_units_booked, id_is_closed, collection_area_id, collection_area!inner(name, code, client_id, capacity_pool_id)',
          { count: 'exact' }
        )
        .order('date', { ascending: true })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (!showPast) {
        query = query.gte('date', today)
      }
      if (clientId) {
        query = query.eq('collection_area.client_id', clientId)
      }
      if (filterFrom) {
        query = query.gte('date', filterFrom)
      }
      if (filterTo) {
        query = query.lte('date', filterTo)
      }
      if (filterAreaId) {
        query = query.eq('collection_area_id', filterAreaId)
      }

      const { data, count } = await query
      return { dates: data ?? [], total: count ?? 0 }
    },
  })

  const dates = datesData?.dates ?? []
  const total = datesData?.total ?? 0

  // WA public holidays, resolved at read time so a holiday closure can be
  // distinguished from an admin/capacity closure in the Open column (VER-221).
  // public_holiday is a small (~dozen-row) `USING(true)` table, fetched once
  // and cached by TanStack Query. Not tenant-scoped — WA holidays apply to all.
  const { data: holidays } = useQuery({
    queryKey: ['public-holidays'],
    queryFn: async () => {
      const { data } = await supabase
        .from('public_holiday')
        .select('date, name')
        .eq('jurisdiction', 'WA')
      return data ?? []
    },
  })
  const holidayNames = new Map((holidays ?? []).map((h) => [h.date, h.name]))

  // For pool-member areas in the visible page, fetch authoritative pool
  // counters. Per-area `collection_date.*` stays at 0 by design for these
  // (migration 20260513080000_capacity_pool) — reading direct columns gives
  // misleading zeros. Indexed by `${poolId}|${date}` because one page can
  // span multiple pools.
  const pagePoolIds = Array.from(
    new Set(
      dates
        .map((d) => (d.collection_area as { capacity_pool_id: string | null }).capacity_pool_id)
        .filter((id): id is string => id !== null),
    ),
  )
  const pageDateIsos = dates.map((d) => d.date)
  const { data: pagePoolDates, isLoading: isPoolLoading } = useQuery({
    queryKey: ['admin-pool-dates', pagePoolIds.sort().join(','), pageDateIsos.join(',')],
    enabled: pagePoolIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from('collection_date_pool')
        .select(
          `date, capacity_pool_id,
           bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
           anc_capacity_limit, anc_units_booked, anc_is_closed,
           id_capacity_limit, id_units_booked, id_is_closed`,
        )
        .in('capacity_pool_id', pagePoolIds)
        .in('date', pageDateIsos)
      return data ?? []
    },
  })
  const poolDateByKey = new Map(
    (pagePoolDates ?? []).map((p) => [`${p.capacity_pool_id}|${p.date}`, p]),
  )

  function generateBulkDates(): string[] {
    if (!bulkStartDate || bulkCount <= 0) return []
    const result: string[] = []
    let current = new Date(bulkStartDate + 'T00:00:00')
    for (let i = 0; i < bulkCount; i++) {
      result.push(format(current, 'yyyy-MM-dd'))
      if (bulkFrequency === 'weekly') current = addWeeks(current, 1)
      else if (bulkFrequency === 'fortnightly') current = addWeeks(current, 2)
      else current = addMonths(current, 1)
    }
    return result
  }

  async function handleCreate() {
    if (!createAreaId || !createDate) return
    setIsCreating(true)
    setCreateError(null)

    const { error } = await supabase.from('collection_date').insert({
      collection_area_id: createAreaId,
      date: createDate,
      for_mud: createForMud,
      bulk_capacity_limit: createBulkLimit,
      anc_capacity_limit: createAncLimit,
      id_capacity_limit: createIdLimit,
      is_open: createIsOpen,
    })

    setIsCreating(false)
    if (error) {
      setCreateError(error.message)
      return
    }

    setShowCreate(false)
    setCreateDate('')
    setCreateForMud(false)
    void queryClient.invalidateQueries({ queryKey: ['admin-collection-dates'] })
  }

  async function handleBulkCreate() {
    if (!bulkAreaId || !bulkStartDate) return
    const bulkDates = generateBulkDates()
    if (bulkDates.length === 0) return

    setIsBulkCreating(true)
    setBulkError(null)

    const rows = bulkDates.map((date) => ({
      collection_area_id: bulkAreaId,
      date,
      for_mud: false,
      bulk_capacity_limit: bulkBulkLimit,
      anc_capacity_limit: bulkAncLimit,
      id_capacity_limit: bulkIdLimit,
      is_open: true,
    }))

    const { error } = await supabase.from('collection_date').insert(rows)

    setIsBulkCreating(false)
    if (error) {
      setBulkError(error.message)
      return
    }

    setShowBulkCreate(false)
    setShowBulkPreview(false)
    setBulkStartDate('')
    void queryClient.invalidateQueries({ queryKey: ['admin-collection-dates'] })
  }

  function startEdit(d: (typeof dates)[number]) {
    setEditingId(d.id)
    setEditBulkLimit(d.bulk_capacity_limit)
    setEditAncLimit(d.anc_capacity_limit)
    setEditIdLimit(d.id_capacity_limit)
    setEditIsOpen(d.is_open)
    setEditForMud(d.for_mud)
  }

  async function handleSaveEdit(id: string) {
    setIsSaving(true)
    await supabase
      .from('collection_date')
      .update({
        bulk_capacity_limit: editBulkLimit,
        anc_capacity_limit: editAncLimit,
        id_capacity_limit: editIdLimit,
        is_open: editIsOpen,
        for_mud: editForMud,
      })
      .eq('id', id)

    setIsSaving(false)
    setEditingId(null)
    void queryClient.invalidateQueries({ queryKey: ['admin-collection-dates'] })
  }

  async function handleDelete(d: (typeof dates)[number]) {
    if (d.bulk_units_booked > 0 || d.anc_units_booked > 0 || d.id_units_booked > 0) return
    if (!confirm(`Delete collection date ${format(new Date(d.date + 'T00:00:00'), 'EEE d MMM yyyy')}?`)) return

    await supabase.from('collection_date').delete().eq('id', d.id)
    void queryClient.invalidateQueries({ queryKey: ['admin-collection-dates'] })
  }

  async function handleShowAudit(dateId: string) {
    setAuditDialogId(dateId)
    setAuditLoading(true)
    setAuditEntries([])
    const entries = await fetchCollectionDateAudit(dateId)
    setAuditEntries(entries)
    setAuditLoading(false)
  }

  const bulkPreviewDates = showBulkPreview ? generateBulkDates() : []
  const createAreaPool = createAreaId ? areaPoolById.get(createAreaId) ?? null : null
  const createAreaIsPooled = createAreaPool?.poolId != null
  const bulkAreaPool = bulkAreaId ? areaPoolById.get(bulkAreaId) ?? null : null
  const bulkAreaIsPooled = bulkAreaPool?.poolId != null

  return (
    <>
      {/* Header */}
      <PageHeader title="Collection Dates" subtitle={`${total} date${total !== 1 ? 's' : ''}`}>
        <button
          type="button"
          onClick={() => setShowPast((p) => !p)}
          className={`rounded-lg border px-3 py-2 text-body-sm font-medium transition-colors ${
            showPast
              ? 'border-[#293F52] bg-[#293F52] text-white'
              : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {showPast ? 'Hide past dates' : 'Show past dates'}
        </button>
        {isContractorAdmin && (
          <>
            <button
              type="button"
              onClick={() => { setShowBulkCreate((p) => !p); setShowCreate(false) }}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-body-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Bulk Create
            </button>
            <button
              type="button"
              onClick={() => { setShowCreate((p) => !p); setShowBulkCreate(false) }}
              className="rounded-lg bg-[#00E47C] px-4 py-2 text-body-sm font-semibold text-[#293F52]"
            >
              + New Date
            </button>
          </>
        )}
      </PageHeader>

      {/* Filters */}
      <FilterBar>
        <div className="flex items-center gap-1.5">
          <label htmlFor="filter-from" className="text-xs font-medium text-gray-500">From</label>
          <input
            id="filter-from"
            type="date"
            value={filterFrom}
            onChange={(e) => { setFilterFrom(e.target.value); setPage(0) }}
            aria-label="Filter from date"
            className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="filter-to" className="text-xs font-medium text-gray-500">To</label>
          <input
            id="filter-to"
            type="date"
            value={filterTo}
            onChange={(e) => { setFilterTo(e.target.value); setPage(0) }}
            aria-label="Filter to date"
            className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
          />
        </div>

        <FilterSelect
          value={filterAreaId}
          onChange={(e) => { setFilterAreaId(e.target.value); setPage(0) }}
          aria-label="Filter by collection area"
        >
          <option value="">All Areas</option>
          {(areas ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
          ))}
        </FilterSelect>

        {(filterFrom || filterTo || filterAreaId) && (
          <button
            type="button"
            onClick={() => { setFilterFrom(''); setFilterTo(''); setFilterAreaId(''); setPage(0) }}
            className="rounded-lg border border-gray-200 bg-white px-3 py-[7px] text-body-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Clear
          </button>
        )}
      </FilterBar>

      {/* Create form */}
      {showCreate && (
        <div className="mx-7 mt-4 rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-semibold text-[#293F52]">Create Collection Date</h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Collection Area</label>
              <select value={createAreaId} onChange={(e) => setCreateAreaId(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <option value="">Select area</option>
                {(areas ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Date</label>
              <input type="date" value={createDate} onChange={(e) => setCreateDate(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            </div>
            <div className="flex items-end gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={createForMud} onChange={(e) => setCreateForMud(e.target.checked)} className="rounded" />
                MUD date
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={createIsOpen} onChange={(e) => setCreateIsOpen(e.target.checked)} className="rounded" />
                Open
              </label>
            </div>
          </div>
          <div className={`mt-3 grid gap-3 ${showAnc ? 'grid-cols-3' : 'grid-cols-2'}`}>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Bulk Limit</label>
              <input type="number" value={createBulkLimit} onChange={(e) => setCreateBulkLimit(Number(e.target.value))} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            </div>
            {showAnc && (
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">ANC Limit</label>
                <input type="number" value={createAncLimit} onChange={(e) => setCreateAncLimit(Number(e.target.value))} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">ID Limit</label>
              <input type="number" value={createIdLimit} onChange={(e) => setCreateIdLimit(Number(e.target.value))} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            </div>
          </div>
          {createError && <p className="mt-2 text-sm text-red-600">{createError}</p>}
          {createAreaIsPooled && (
            <p className="mt-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
              This area shares capacity via the <strong>{createAreaPool?.poolCode}</strong> pool. Date rows for pool areas are scheduled via the pool admin — per-date limits here do not apply.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={handleCreate} disabled={isCreating || !createAreaId || !createDate || createAreaIsPooled} className="rounded-lg bg-[#293F52] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {isCreating ? 'Creating...' : 'Create Date'}
            </button>
            <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600">Cancel</button>
          </div>
        </div>
      )}

      {/* Bulk create form */}
      {showBulkCreate && (
        <div className="mx-7 mt-4 rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-semibold text-[#293F52]">Bulk Create Collection Dates</h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Collection Area</label>
              <select value={bulkAreaId} onChange={(e) => setBulkAreaId(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <option value="">Select area</option>
                {(areas ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Start Date</label>
              <input type="date" value={bulkStartDate} onChange={(e) => { setBulkStartDate(e.target.value); setShowBulkPreview(false) }} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Number of Dates</label>
              <input type="number" min={1} max={52} value={bulkCount} onChange={(e) => { setBulkCount(Number(e.target.value)); setShowBulkPreview(false) }} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Frequency</label>
              <select value={bulkFrequency} onChange={(e) => { setBulkFrequency(e.target.value as Frequency); setShowBulkPreview(false) }} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <option value="weekly">Weekly</option>
                <option value="fortnightly">Fortnightly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          </div>
          <div className={`mt-3 grid gap-3 ${showAnc ? 'grid-cols-3' : 'grid-cols-2'}`}>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Bulk Limit</label>
              <input type="number" value={bulkBulkLimit} onChange={(e) => setBulkBulkLimit(Number(e.target.value))} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            </div>
            {showAnc && (
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">ANC Limit</label>
                <input type="number" value={bulkAncLimit} onChange={(e) => setBulkAncLimit(Number(e.target.value))} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">ID Limit</label>
              <input type="number" value={bulkIdLimit} onChange={(e) => setBulkIdLimit(Number(e.target.value))} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            </div>
          </div>
          {!showBulkPreview && (
            <button type="button" onClick={() => setShowBulkPreview(true)} disabled={!bulkAreaId || !bulkStartDate || bulkCount <= 0} className="mt-3 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 disabled:opacity-50">
              Preview Dates
            </button>
          )}
          {showBulkPreview && bulkPreviewDates.length > 0 && (
            <div className="mt-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
              <div className="mb-2 text-xs font-semibold text-gray-500">{bulkPreviewDates.length} dates will be created:</div>
              <div className="flex flex-wrap gap-1.5">
                {bulkPreviewDates.map((d) => (
                  <span key={d} className="rounded-full bg-white px-2.5 py-0.5 text-xs font-medium text-[#293F52] shadow-sm">
                    {format(new Date(d + 'T00:00:00'), 'EEE d MMM yyyy')}
                  </span>
                ))}
              </div>
            </div>
          )}
          {bulkError && <p className="mt-2 text-sm text-red-600">{bulkError}</p>}
          {bulkAreaIsPooled && (
            <p className="mt-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
              This area shares capacity via the <strong>{bulkAreaPool?.poolCode}</strong> pool. Date rows for pool areas are scheduled via the pool admin — per-date limits here do not apply.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            {showBulkPreview && (
              <button type="button" onClick={handleBulkCreate} disabled={isBulkCreating || bulkAreaIsPooled} className="rounded-lg bg-[#293F52] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {isBulkCreating ? 'Creating...' : `Create ${bulkPreviewDates.length} Dates`}
              </button>
            )}
            <button type="button" onClick={() => { setShowBulkCreate(false); setShowBulkPreview(false) }} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600">Cancel</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="mx-7 mt-6 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm tabular-nums">
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Area</Th>
              <Th className="text-center">Type</Th>
              <Th className="text-center">Open</Th>
              <Th>Collections</Th>
              {showAnc && <Th>ANC</Th>}
              <Th>ID</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <>{Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={showAnc ? 8 : 7} />
              ))}</>
            ) : dates.length === 0 ? (
              <tr><td colSpan={showAnc ? 8 : 7} className="px-4 py-8 text-center text-gray-400">No collection dates found</td></tr>
            ) : (
              dates.map((d) => {
                const area = d.collection_area as { name: string; code: string; capacity_pool_id: string | null }
                const poolId = area.capacity_pool_id ?? null
                const poolRow = poolId ? poolDateByKey.get(`${poolId}|${d.date}`) ?? null : null
                const cap = effectiveCapacity(d, poolId, poolRow ? indexPoolDates([poolRow]) : new Map())
                const isPast = d.date < today
                const isEditing = editingId === d.id
                const hasBookings = cap.bulk_units_booked > 0 || cap.anc_units_booked > 0 || cap.id_units_booked > 0
                const isPooled = poolId !== null

                if (isEditing) {
                  return (
                    <tr key={d.id} className="border-b border-gray-50 bg-blue-50/50">
                      <td className="px-4 py-2.5 font-medium text-[#293F52]">{format(new Date(d.date + 'T00:00:00'), 'EEE d MMM yyyy')}</td>
                      <td className="px-4 py-2.5 text-gray-600">{area.code}</td>
                      <td className="px-4 py-2.5 text-center">
                        <label className="flex items-center justify-center gap-1.5 text-2xs font-semibold text-[#805AD5]">
                          <input type="checkbox" checked={editForMud} onChange={(e) => setEditForMud(e.target.checked)} className="rounded" />
                          MUD
                        </label>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {(() => {
                          // Locked/past dates can't be reopened (locked_closed is
                          // sticky; the dot derives Closed from all four signals) —
                          // a live checkbox here would be a silent no-op, and a
                          // CHECKED disabled box is BR-0018's mixed signal again.
                          // Save payload is untouched. Title lives on a wrapper:
                          // disabled inputs don't reliably fire tooltips.
                          const editLocked = d.locked_closed || isPast
                          return (
                            <span title={editLocked ? (isPast ? 'Date has passed' : 'Locked at T-3 cutoff — cannot reopen') : undefined}>
                              <input
                                type="checkbox"
                                checked={editLocked ? false : editIsOpen}
                                disabled={editLocked}
                                onChange={(e) => setEditIsOpen(e.target.checked)}
                                className="rounded disabled:cursor-not-allowed disabled:opacity-40"
                              />
                            </span>
                          )
                        })()}
                      </td>
                      <td className="px-4 py-2.5"><input type="number" value={editBulkLimit} onChange={(e) => setEditBulkLimit(Number(e.target.value))} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" /></td>
                      {showAnc && <td className="px-4 py-2.5"><input type="number" value={editAncLimit} onChange={(e) => setEditAncLimit(Number(e.target.value))} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" /></td>}
                      <td className="px-4 py-2.5"><input type="number" value={editIdLimit} onChange={(e) => setEditIdLimit(Number(e.target.value))} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" /></td>
                      <td className="px-4 py-2.5 text-right">
                        <button type="button" onClick={() => handleSaveEdit(d.id)} disabled={isSaving} className="mr-1 text-xs font-semibold text-[#00B864]">{isSaving ? 'Saving...' : 'Save'}</button>
                        <button type="button" onClick={() => setEditingId(null)} className="text-xs text-gray-400">Cancel</button>
                      </td>
                    </tr>
                  )
                }

                return (
                  <tr key={d.id} className={`border-b border-gray-50 ${isPast ? 'bg-gray-50/50 text-gray-400' : ''}`}>
                    <td className={`px-4 py-2.5 font-medium ${isPast ? 'text-gray-400' : 'text-[#293F52]'}`}>
                      {format(new Date(d.date + 'T00:00:00'), 'EEE d MMM yyyy')}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">
                      {area.code}
                      {isPooled && (
                        <span
                          className="ml-1.5 rounded-full bg-indigo-50 px-1.5 py-0.5 text-2xs font-semibold text-indigo-700"
                          title="Capacity shared via pool — limits managed at pool level"
                        >
                          pool
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {d.for_mud && <span className="rounded-full bg-[#F3EEFF] px-2 py-0.5 text-2xs font-semibold text-[#805AD5]">MUD</span>}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {(() => {
                        // Pool counters are authoritative for pooled areas — don't
                        // assert Open/Closed until they've arrived (VER-259 D-F8).
                        if (isPooled && isPoolLoading) {
                          return <span className="inline-block size-2 animate-pulse rounded-full bg-gray-200" title="Loading capacity…" />
                        }
                        const input = {
                          isOpen: d.is_open,
                          lockedClosed: d.locked_closed,
                          isPast,
                          // Same pool-merged signal the bucket badges render —
                          // that identity is the BR-0018 fix.
                          allBucketsClosed: cap.bulk_is_closed && cap.anc_is_closed && cap.id_is_closed,
                          date: d.date,
                        }
                        const status = closureStatus(input, holidayNames)
                        if (status === 'open') {
                          return <span className="inline-block size-2 rounded-full bg-status-success" title="Open" />
                        }
                        const reason = closureReason(input) ?? 'manual'
                        if (status === 'holiday') {
                          const name = holidayNames.get(d.date) ?? 'Public holiday'
                          const title =
                            reason === 'manual'
                              ? `Closed — ${name}`
                              : `Closed — ${name} · ${CLOSURE_REASON[reason].why}`
                          return (
                            <span className="whitespace-nowrap rounded-full bg-status-warn-bg px-2 py-0.5 text-2xs font-semibold text-status-warn" title={title}>
                              {name}
                            </span>
                          )
                        }
                        return (
                          <span className="inline-flex items-center gap-1.5" title={CLOSURE_REASON[reason].title}>
                            <span className="inline-block size-2 rounded-full bg-gray-300" />
                            <span className="whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-2xs font-semibold text-gray-500">
                              {CLOSURE_REASON[reason].pill}
                            </span>
                          </span>
                        )
                      })()}
                    </td>
                    {/* Bulk capacity */}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className={`h-1.5 w-16 overflow-hidden rounded-full ${capacityBgColor(cap.bulk_units_booked, cap.bulk_capacity_limit)}`}>
                          <div className={`h-full rounded-full ${capacityColor(cap.bulk_units_booked, cap.bulk_capacity_limit)}`} style={{ width: `${Math.min(100, cap.bulk_capacity_limit > 0 ? (cap.bulk_units_booked / cap.bulk_capacity_limit) * 100 : 0)}%` }} />
                        </div>
                        <span className="text-caption text-gray-500">{cap.bulk_units_booked}/{cap.bulk_capacity_limit}</span>
                        {cap.bulk_is_closed && <span className="rounded bg-red-100 px-1 py-px text-2xs font-semibold text-red-600">Closed</span>}
                      </div>
                    </td>
                    {/* ANC capacity */}
                    {showAnc && (
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <div className={`h-1.5 w-16 overflow-hidden rounded-full ${capacityBgColor(cap.anc_units_booked, cap.anc_capacity_limit)}`}>
                            <div className={`h-full rounded-full ${capacityColor(cap.anc_units_booked, cap.anc_capacity_limit)}`} style={{ width: `${Math.min(100, cap.anc_capacity_limit > 0 ? (cap.anc_units_booked / cap.anc_capacity_limit) * 100 : 0)}%` }} />
                          </div>
                          <span className="text-caption text-gray-500">{cap.anc_units_booked}/{cap.anc_capacity_limit}</span>
                          {cap.anc_is_closed && <span className="rounded bg-red-100 px-1 py-px text-2xs font-semibold text-red-600">Closed</span>}
                        </div>
                      </td>
                    )}
                    {/* ID capacity */}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className={`h-1.5 w-16 overflow-hidden rounded-full ${capacityBgColor(cap.id_units_booked, cap.id_capacity_limit)}`}>
                          <div className={`h-full rounded-full ${capacityColor(cap.id_units_booked, cap.id_capacity_limit)}`} style={{ width: `${Math.min(100, cap.id_capacity_limit > 0 ? (cap.id_units_booked / cap.id_capacity_limit) * 100 : 0)}%` }} />
                        </div>
                        <span className="text-caption text-gray-500">{cap.id_units_booked}/{cap.id_capacity_limit}</span>
                        {cap.id_is_closed && <span className="rounded bg-red-100 px-1 py-px text-2xs font-semibold text-red-600">Closed</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => startEdit(d)}
                        disabled={isPooled}
                        title={isPooled ? 'Capacity managed at pool level' : 'Edit'}
                        className={`mr-2 text-xs font-medium ${isPooled ? 'cursor-not-allowed text-gray-300' : 'text-[#293F52] hover:underline'}`}
                      >
                        Edit
                      </button>
                      <button type="button" onClick={() => handleShowAudit(d.id)} className="mr-2 text-xs font-medium text-gray-500 hover:underline">History</button>
                      <button
                        type="button"
                        onClick={() => handleDelete(d)}
                        disabled={hasBookings}
                        title={hasBookings ? 'Cannot delete — bookings exist' : 'Delete'}
                        className={`text-xs font-medium ${hasBookings ? 'cursor-not-allowed text-gray-300' : 'text-red-500 hover:underline'}`}
                      >
                        Delete
                      </button>
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

      {/* Audit history dialog */}
      <Dialog.Root open={!!auditDialogId} onOpenChange={() => setAuditDialogId(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
                <Dialog.Title className="font-[family-name:var(--font-heading)] text-base font-bold text-[#293F52]">
                  Change History
                </Dialog.Title>
                <Dialog.Close className="text-gray-400 hover:text-gray-600">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </Dialog.Close>
              </div>
              <div className="max-h-[60vh] overflow-y-auto">
                {auditLoading ? (
                  <div className="px-5 py-8 text-center text-sm text-gray-400">Loading...</div>
                ) : auditEntries.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-gray-400">No changes recorded</div>
                ) : (
                  <AuditTimeline entries={auditEntries} />
                )}
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
