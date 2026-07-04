'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { SkeletonRow } from '@/components/ui/skeleton'
import { RowActionMenu } from '@/components/admin/row-action-menu'
import { StatusBadge } from '@/components/status-badge'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'
import { Th } from '@/components/admin/th'
import { Pagination } from '@/components/admin/pagination'
import type { Database } from '@/lib/supabase/types'

type TicketStatus = Database['public']['Enums']['ticket_status']
type TicketPriority = Database['public']['Enums']['ticket_priority']
type TicketCategory = Database['public']['Enums']['ticket_category']

const PAGE_SIZE = 50

const STATUS_OPTIONS: { value: TicketStatus | ''; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'waiting_on_customer', label: 'Waiting' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
]

const PRIORITY_OPTIONS: { value: TicketPriority | ''; label: string }[] = [
  { value: '', label: 'All Priorities' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
]

const CATEGORY_OPTIONS: { value: TicketCategory | ''; label: string }[] = [
  { value: '', label: 'All Categories' },
  { value: 'general', label: 'General' },
  { value: 'booking', label: 'Booking Enquiry' },
  { value: 'billing', label: 'Billing' },
  { value: 'service', label: 'Service Issue' },
  { value: 'complaint', label: 'Complaint' },
  { value: 'other', label: 'Other' },
]


const CATEGORY_LABELS: Record<TicketCategory, string> = {
  general: 'General',
  booking: 'Booking Enquiry',
  billing: 'Billing',
  service: 'Service Issue',
  complaint: 'Complaint',
  other: 'Other',
}

interface ServiceTicketsClientProps {
  clientId: string
}

export function ServiceTicketsClient({ clientId }: ServiceTicketsClientProps) {
  const supabase = createClient()
  const queryClient = useQueryClient()

  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  // Debounce search
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

  const { data: ticketsData, isLoading } = useQuery({
    queryKey: ['admin-tickets', clientId, statusFilter, priorityFilter, categoryFilter, debouncedSearch, page],
    queryFn: async () => {
      let query = supabase
        .from('service_ticket')
        .select(
          `id, display_id, subject, status, priority, category, channel, created_at, assigned_to,
           contact:contact_id(full_name),
           assigned_profile:assigned_to(display_name)`,
          { count: 'exact' }
        )
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (clientId) query = query.eq('client_id', clientId)
      if (statusFilter) query = query.eq('status', statusFilter as TicketStatus)
      if (priorityFilter) query = query.eq('priority', priorityFilter as TicketPriority)
      if (categoryFilter) query = query.eq('category', categoryFilter as TicketCategory)
      if (debouncedSearch) query = query.ilike('subject', `%${debouncedSearch}%`)

      const { data, count } = await query
      return { tickets: data ?? [], total: count ?? 0 }
    },
  })

  const tickets = ticketsData?.tickets ?? []
  const total = ticketsData?.total ?? 0

  async function handleQuickAction(ticketId: string, action: 'assign' | 'resolve' | 'close') {
    if (action === 'assign') {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        await supabase
          .from('service_ticket')
          .update({ assigned_to: user.id, status: 'in_progress' })
          .eq('id', ticketId)
      }
    } else if (action === 'resolve') {
      await supabase
        .from('service_ticket')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() })
        .eq('id', ticketId)
    } else if (action === 'close') {
      await supabase
        .from('service_ticket')
        .update({ status: 'closed', closed_at: new Date().toISOString() })
        .eq('id', ticketId)
    }

    void queryClient.invalidateQueries({ queryKey: ['admin-tickets'] })
  }

  return (
    <>
      <PageHeader title="Service Tickets" subtitle={`${total} ticket${total !== 1 ? 's' : ''}`} />

      {/* Filters */}
      <FilterBar>
        <SearchInput
          value={search}
          onChange={handleSearchChange}
          placeholder="Search by subject..."
          ariaLabel="Search service tickets"
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
      <div className="mx-7 overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-left text-sm tabular-nums">
          <thead>
            <tr>
              <Th>Ticket</Th>
              <Th>Subject</Th>
              <Th>Resident</Th>
              <Th>Category</Th>
              <Th>Priority</Th>
              <Th>Status</Th>
              <Th>Assigned</Th>
              <Th>Created</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <>{Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={9} />
              ))}</>
            ) : tickets.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">No tickets found</td></tr>
            ) : (
              tickets.map((t) => {
                const contact = t.contact as { full_name: string } | null
                const assignedProfile = t.assigned_profile as { display_name: string | null } | null

                return (
                  <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-2.5">
                      <Link href={`/admin/service-tickets/${t.display_id}`} className="font-mono text-xs text-gray-400 hover:text-[#293F52] hover:underline">
                        {t.display_id}
                      </Link>
                    </td>
                    <td className="max-w-[240px] px-4 py-2.5">
                      <Link href={`/admin/service-tickets/${t.display_id}`} className="font-semibold text-[#293F52] hover:underline">
                        {t.subject.length > 60 ? t.subject.slice(0, 60) + '...' : t.subject}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{contact?.full_name ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-caption font-medium text-gray-600">
                        {CATEGORY_LABELS[t.category as TicketCategory] ?? t.category}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge entity="ticketPriority" status={t.priority} />
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge entity="ticket" status={t.status} />
                    </td>
                    <td className="px-4 py-2.5 text-body-sm text-gray-500">
                      {assignedProfile?.display_name ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-body-sm text-gray-500">
                      {formatDistanceToNow(new Date(t.created_at), { addSuffix: true })}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <RowActionMenu
                        actions={[
                          { label: 'Assign to me', onSelect: () => { void handleQuickAction(t.id, 'assign') } },
                          { label: 'Mark resolved', onSelect: () => { void handleQuickAction(t.id, 'resolve') } },
                          { label: 'Mark closed', onSelect: () => { void handleQuickAction(t.id, 'close') } },
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

      <Pagination className="mx-7" page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
    </>
  )
}
