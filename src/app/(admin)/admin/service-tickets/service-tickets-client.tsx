'use client'

import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { getStatusStyle } from '@/lib/ui/status-styles'
import Link from 'next/link'
import { SkeletonRow } from '@/components/ui/skeleton'
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


const PRIORITY_STYLE: Record<TicketPriority, { bg: string; text: string; label: string }> = {
  low: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Low' },
  normal: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Normal' },
  high: { bg: 'bg-amber-50', text: 'text-amber-700', label: 'High' },
  urgent: { bg: 'bg-red-50', text: 'text-red-700', label: 'Urgent' },
}

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
  const [actionMenuId, setActionMenuId] = useState<string | null>(null)
  const menuRef = useRef<HTMLTableCellElement>(null)

  // Close action menu on outside click
  useEffect(() => {
    if (!actionMenuId) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActionMenuId(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [actionMenuId])

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
    setActionMenuId(null)

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
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Service Tickets
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            {total} ticket{total !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3 px-7 pt-6">
        <input
          type="text"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search by subject..."
          aria-label="Search service tickets"
          className="w-full max-w-xs rounded-lg border border-gray-200 px-3.5 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-[#293F52]"
        />
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }} aria-label="Filter by status" className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={priorityFilter} onChange={(e) => { setPriorityFilter(e.target.value); setPage(0) }} aria-label="Filter by priority" className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          {PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setPage(0) }} aria-label="Filter by category" className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="mx-7 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-500">
              <th className="px-4 py-3">Ticket</th>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">Resident</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Assigned</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
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
                const ss = getStatusStyle('ticket', t.status)
                const ps = PRIORITY_STYLE[t.priority as TicketPriority]

                return (
                  <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-2.5">
                      <Link href={`/admin/service-tickets/${t.display_id}`} className="font-mono text-[12px] text-gray-400 hover:text-[#293F52] hover:underline">
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
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                        {CATEGORY_LABELS[t.category as TicketCategory] ?? t.category}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ps.bg} ${ps.text}`}>
                        {ps.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ss.bg} ${ss.text}`}>
                        {ss.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-body-sm text-gray-500">
                      {assignedProfile?.display_name ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-body-sm text-gray-500">
                      {formatDistanceToNow(new Date(t.created_at), { addSuffix: true })}
                    </td>
                    <td className="relative px-4 py-2.5 text-right" ref={actionMenuId === t.id ? menuRef : undefined}>
                      <button
                        type="button"
                        onClick={() => setActionMenuId(actionMenuId === t.id ? null : t.id)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                        aria-label="Open actions menu"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
                        </svg>
                      </button>
                      {actionMenuId === t.id && (
                        <div className="absolute right-4 top-10 z-10 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                          <button type="button" onClick={() => handleQuickAction(t.id, 'assign')} className="block w-full px-4 py-2 text-left text-body-sm text-gray-700 hover:bg-gray-50">Assign to me</button>
                          <button type="button" onClick={() => handleQuickAction(t.id, 'resolve')} className="block w-full px-4 py-2 text-left text-body-sm text-gray-700 hover:bg-gray-50">Mark resolved</button>
                          <button type="button" onClick={() => handleQuickAction(t.id, 'close')} className="block w-full px-4 py-2 text-left text-body-sm text-gray-700 hover:bg-gray-50">Mark closed</button>
                        </div>
                      )}
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
          <span>Showing {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, total)} of {total}</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium disabled:opacity-30">Previous</button>
            <button type="button" onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * PAGE_SIZE >= total} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium disabled:opacity-30">Next</button>
          </div>
        </div>
      )}
    </>
  )
}
