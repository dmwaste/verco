'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'
import { getStatusStyle } from '@/lib/ui/status-styles'
import Link from 'next/link'
import { SkeletonRow } from '@/components/ui/skeleton'
import { RowActionMenu } from '@/components/admin/row-action-menu'
import { invokeEfWithUserToken } from '@/lib/supabase/invoke-ef-client'

const STATUS_OPTIONS = ['Pending', 'Approved', 'Rejected'] as const

const PAGE_SIZE = 20

export function RefundsClient() {
  const supabase = createClient()
  const queryClient = useQueryClient()

  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const { data: refundData, isLoading } = useQuery({
    queryKey: ['admin-refunds', statusFilter, search, page],
    queryFn: async () => {
      let query = supabase
        .from('refund_request')
        .select(
          `id, amount_cents, reason, status, stripe_refund_id, created_at, reviewed_at,
           booking:booking_id(id, ref),
           contact:contact_id(full_name),
           reviewer:reviewed_by(display_name)`,
          { count: 'exact' }
        )
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (statusFilter) query = query.eq('status', statusFilter)
      if (search) {
        query = query.or(buildSearchOrFilter(['reason'], search))
      }

      const { data, count } = await query
      return { refunds: data ?? [], total: count ?? 0 }
    },
  })

  const refunds = refundData?.refunds ?? []
  const total = refundData?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  async function handleAction(refundId: string, action: 'approve' | 'reject') {
    setActionError(null)
    setProcessingId(refundId)

    try {
      if (action === 'approve') {
        const result = await invokeEfWithUserToken(supabase, 'process-refund', { refund_request_id: refundId })
        if (!result.ok) {
          setActionError(`Refund failed: ${result.error}`)
          return
        }
      } else {
        // Reject — just update the DB status
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          setActionError('Session expired. Please refresh the page and sign in again.')
          setProcessingId(null)
          return
        }

        const { error } = await supabase
          .from('refund_request')
          .update({
            status: 'Rejected',
            reviewed_by: user.id,
            reviewed_at: new Date().toISOString(),
          })
          .eq('id', refundId)

        if (error) {
          setActionError(`Failed to reject: ${error.message}`)
          return
        }
      }

      void queryClient.invalidateQueries({ queryKey: ['admin-refunds'] })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setProcessingId(null)
    }
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Refund Requests
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            {total} requests
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
            onChange={(e) => { setSearch(e.target.value); setPage(0) }}
            placeholder="Search reason..."
            aria-label="Search refund requests"
            className="w-full border-none bg-transparent text-body-sm text-gray-900 outline-none placeholder:text-gray-300"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
          aria-label="Filter by status"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{getStatusStyle('refund', s).label}</option>
          ))}
        </select>

        <div className="flex-1" />
        <span className="text-xs text-gray-500">
          Showing {total > 0 ? page * PAGE_SIZE + 1 : 0}&ndash;{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
        </span>
      </div>

      {/* Error banner */}
      {actionError && (
        <div role="alert" className="mx-7 mb-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
          {actionError}
          <button type="button" onClick={() => setActionError(null)} className="ml-2 font-semibold underline">Dismiss</button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Booking</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Resident</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Amount</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Reason</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Status</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Stripe Ref</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Requested</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Reviewed By</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={9} />
              ))}
              {!isLoading && refunds.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-sm text-gray-400">No refund requests found</td></tr>
              )}
              {refunds.map((refund) => {
                const booking = refund.booking as unknown as { id: string; ref: string } | null
                const contact = refund.contact as { full_name: string } | null
                const reviewer = refund.reviewer as { display_name: string | null } | null
                const ss = getStatusStyle('refund', refund.status)
                return (
                  <tr key={refund.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      {booking ? (
                        <Link
                          href={`/admin/bookings/${booking.id}`}
                          className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52] hover:underline"
                        >
                          {booking.ref}
                        </Link>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-body-sm text-gray-600">
                      {contact?.full_name ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52]">
                      ${(refund.amount_cents / 100).toFixed(2)}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3 text-xs">
                      {refund.reason || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${ss.bg} ${ss.text}`}>
                        {ss.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-gray-400">
                      {refund.stripe_refund_id ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {format(new Date(refund.created_at), 'd MMM yyyy')}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {reviewer?.display_name ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      {refund.status === 'Pending' && (
                        <>
                          {processingId === refund.id ? (
                            <span className="text-xs text-gray-400">Processing...</span>
                          ) : (
                            <RowActionMenu
                              actions={[
                                { label: 'Approve & Refund', onSelect: () => handleAction(refund.id, 'approve') },
                                { label: 'Reject', onSelect: () => handleAction(refund.id, 'reject'), tone: 'danger' },
                              ]}
                            />
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2">
            <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="rounded-md border border-gray-100 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40">Previous</button>
            <span className="text-xs text-gray-500">Page {page + 1} of {totalPages}</span>
            <button type="button" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="rounded-md border border-gray-100 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40">Next</button>
          </div>
        )}
      </div>
    </>
  )
}
