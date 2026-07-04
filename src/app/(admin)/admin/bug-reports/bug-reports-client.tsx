'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { RowActionMenu } from '@/components/admin/row-action-menu'
import type { Database } from '@/lib/supabase/types'
import { Th } from '@/components/admin/th'
import { Pagination } from '@/components/admin/pagination'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'
import { StatusBadge } from '@/components/status-badge'

type BugCategory = Database['public']['Enums']['bug_report_category']
type BugPriority = Database['public']['Enums']['bug_report_priority']
type BugStatus = Database['public']['Enums']['bug_report_status']

const STATUS_OPTIONS: { value: BugStatus | ''; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'new', label: 'New' },
  { value: 'triaged', label: 'Triaged' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
  { value: 'wont_fix', label: "Won't Fix" },
]

const PRIORITY_OPTIONS: { value: BugPriority | ''; label: string }[] = [
  { value: '', label: 'All Priorities' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]

const CATEGORY_OPTIONS: { value: BugCategory | ''; label: string }[] = [
  { value: '', label: 'All Categories' },
  { value: 'ui', label: 'UI' },
  { value: 'data', label: 'Data' },
  { value: 'performance', label: 'Performance' },
  { value: 'access', label: 'Access' },
  { value: 'booking', label: 'Booking' },
  { value: 'collection', label: 'Collection' },
  { value: 'billing', label: 'Billing' },
  { value: 'other', label: 'Other' },
]


const PRIORITY_STYLE: Record<BugPriority, { bg: string; text: string; label: string }> = {
  low: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Low' },
  medium: { bg: 'bg-status-info-bg', text: 'text-status-info', label: 'Medium' },
  high: { bg: 'bg-status-warn-bg', text: 'text-status-warn', label: 'High' },
  critical: { bg: 'bg-status-error-bg', text: 'text-status-error', label: 'Critical' },
}

const CATEGORY_LABELS: Record<BugCategory, string> = {
  ui: 'UI',
  data: 'Data',
  performance: 'Performance',
  access: 'Access',
  booking: 'Booking',
  collection: 'Collection',
  billing: 'Billing',
  other: 'Other',
}

const PAGE_SIZE = 50

export function BugReportsClient() {
  const supabase = createClient()
  const queryClient = useQueryClient()

  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  const searchTimerRef = useState<ReturnType<typeof setTimeout> | null>(null)
  function handleSearchChange(value: string) {
    setSearch(value)
    if (searchTimerRef[0]) clearTimeout(searchTimerRef[0])
    const timer = setTimeout(() => {
      setDebouncedSearch(value)
      setPage(0)
    }, 300)
    searchTimerRef[1](timer)
  }

  const { data: bugsData, isLoading } = useQuery({
    queryKey: ['admin-bugs', statusFilter, priorityFilter, categoryFilter, debouncedSearch, page],
    queryFn: async () => {
      let query = supabase
        .from('bug_report')
        .select(
          `id, display_id, title, category, priority, status, source_app, page_url, linear_issue_url, created_at,
           reporter:profiles!bug_report_reporter_id_fkey(display_name),
           assigned:profiles!bug_report_assigned_to_fkey(display_name)`,
          { count: 'exact' }
        )
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (statusFilter) query = query.eq('status', statusFilter as BugStatus)
      if (priorityFilter) query = query.eq('priority', priorityFilter as BugPriority)
      if (categoryFilter) query = query.eq('category', categoryFilter as BugCategory)
      if (debouncedSearch) query = query.ilike('title', `%${debouncedSearch}%`)

      const { data, count } = await query
      return { bugs: data ?? [], total: count ?? 0 }
    },
  })

  const bugs = bugsData?.bugs ?? []
  const total = bugsData?.total ?? 0

  async function handleQuickAction(bugId: string, action: 'assign' | 'triage' | 'resolve' | 'close') {
    if (action === 'assign') {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        await supabase.from('bug_report').update({ assigned_to: user.id, status: 'in_progress' }).eq('id', bugId)
      }
    } else if (action === 'triage') {
      await supabase.from('bug_report').update({ status: 'triaged' }).eq('id', bugId)
    } else if (action === 'resolve') {
      await supabase.from('bug_report').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', bugId)
    } else if (action === 'close') {
      await supabase.from('bug_report').update({ status: 'closed' }).eq('id', bugId)
    }

    void queryClient.invalidateQueries({ queryKey: ['admin-bugs'] })
  }

  return (
    <>
      {/* Header */}
      <PageHeader title="Bug Reports" subtitle={`${total} reports`} />

      {/* Filters */}
      <FilterBar>
        <SearchInput
          value={search}
          onChange={handleSearchChange}
          placeholder="Search by title..."
          ariaLabel="Search bug reports"
        />
        <FilterSelect value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }} aria-label="Filter by status">
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </FilterSelect>
        <FilterSelect value={priorityFilter} onChange={(e) => { setPriorityFilter(e.target.value); setPage(0) }} aria-label="Filter by priority">
          {PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </FilterSelect>
        <FilterSelect value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setPage(0) }} aria-label="Filter by category">
          {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </FilterSelect>
      </FilterBar>

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th>ID</Th>
                <Th>Title</Th>
                <Th>Category</Th>
                <Th>Priority</Th>
                <Th>Status</Th>
                <Th>Reporter</Th>
                <Th>Assigned</Th>
                <Th>Created</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
              ) : bugs.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">No bug reports found</td></tr>
              ) : (
                bugs.map((bug) => {
                  const reporter = bug.reporter as { display_name: string | null } | null
                  const assigned = bug.assigned as { display_name: string | null } | null
                  const ps = PRIORITY_STYLE[bug.priority as BugPriority]

                  return (
                    <tr key={bug.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs text-gray-400">{bug.display_id}</span>
                      </td>
                      <td className="max-w-[240px] px-4 py-2.5">
                        <Link
                          href={`/admin/bug-reports/${bug.id}`}
                          className="font-semibold text-body-sm text-[#293F52] hover:underline"
                        >
                          {bug.title.length > 60 ? bug.title.slice(0, 60) + '...' : bug.title}
                        </Link>
                        {bug.linear_issue_url && (
                          <a href={bug.linear_issue_url} target="_blank" rel="noopener noreferrer" className="ml-1.5 text-caption text-blue-500 hover:underline">Linear</a>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-caption font-medium text-gray-600">
                          {CATEGORY_LABELS[bug.category as BugCategory] ?? bug.category}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-caption font-semibold ${ps.bg} ${ps.text}`}>
                          {ps.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge entity="bug" status={bug.status} />
                      </td>
                      <td className="px-4 py-2.5 text-body-sm text-gray-500">
                        {reporter?.display_name ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-body-sm text-gray-500">
                        {assigned?.display_name ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-body-sm text-gray-500">
                        {formatDistanceToNow(new Date(bug.created_at), { addSuffix: true })}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <RowActionMenu
                          actions={[
                            { label: 'Assign to me', onSelect: () => { void handleQuickAction(bug.id, 'assign') } },
                            { label: 'Mark triaged', onSelect: () => { void handleQuickAction(bug.id, 'triage') } },
                            { label: 'Mark resolved', onSelect: () => { void handleQuickAction(bug.id, 'resolve') } },
                            { label: 'Mark closed', onSelect: () => { void handleQuickAction(bug.id, 'close') } },
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

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      </div>
    </>
  )
}
